import { backupDatabase } from "./backup.js";
import { DepoError } from "./errors.js";
import { Connection, type ConnectionOptions, type SqliteDatabase, type SqliteStatement } from "./sqlite.js";
import type { LeaderboardEntry } from "./leaderboard.js";
import type { RateLimitResult } from "./depo.js";

export const SCHEMA_VERSION = 1;

export interface Row {
  /** JSON text of the stored value. */
  value: string;
  /** Absolute expiry in epoch milliseconds, or `null` for no expiry. */
  expiresAt: number | null;
}

export interface RawEntry {
  key: string;
  value: string;
}

/**
 * One SQLite connection plus the prepared statements for Depo's schema.
 * Shared by every namespace view (`Depo#table`) opened from the same `Depo`.
 *
 * Namespaces are columns, not separate SQL tables, so no identifier is ever built
 * from user input. Sorted scores and rate-limit state have their own tables.
 */
export class Store {
  readonly path: string;
  readonly #conn: Connection;
  #closed = false;
  #pendingBackups = 0;

  readonly #selectRow: SqliteStatement;
  readonly #upsert: SqliteStatement;
  readonly #deleteLive: SqliteStatement;
  readonly #selectAll: SqliteStatement;
  readonly #selectPrefix: SqliteStatement;
  readonly #selectKeys: SqliteStatement;
  readonly #selectPrefixKeys: SqliteStatement;
  readonly #countLive: SqliteStatement;
  readonly #deleteNamespace: SqliteStatement;
  readonly #purge: SqliteStatement;
  readonly #anyExpired: SqliteStatement;
  readonly #setExpiry: SqliteStatement;
  readonly #selectMeta: SqliteStatement;
  readonly #upsertMeta: SqliteStatement;
  readonly #selectFeatureTable: SqliteStatement;

  #scores: ScoreStatements | undefined;
  #limits: LimitStatements | undefined;
  constructor(path: string, options: ConnectionOptions) {
    this.path = path;
    this.#conn = new Connection(path, options);
    const db = this.#conn.db;
    try {
      // Opening an existing file takes no write lock: under heavy write traffic from other
      // processes a late opener would otherwise have to win the lock just to start.
      const version = this.#conn.run(() => readSchemaVersion(db));
      if (version !== undefined) checkVersion(path, version);
      if (!(options.readOnly ?? false) && (version === undefined || !this.#conn.run(() => hasFeatureSchema(db)))) {
        this.#conn.transaction(() => this.#migrate());
      }
      this.#selectRow = db.prepare("SELECT value, expires_at FROM depo_entries WHERE ns = ? AND key = ?");
      this.#upsert = db.prepare(
        "INSERT INTO depo_entries (ns, key, value, expires_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      );
      this.#deleteLive = db.prepare(
        "DELETE FROM depo_entries WHERE ns = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      this.#selectAll = prepareList(db, false, false);
      this.#selectPrefix = prepareList(db, true, false);
      this.#selectKeys = prepareList(db, false, true);
      this.#selectPrefixKeys = prepareList(db, true, true);
      this.#countLive = db.prepare(
        "SELECT count(*) AS n FROM depo_entries WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      this.#deleteNamespace = db.prepare("DELETE FROM depo_entries WHERE ns = ?");
      this.#purge = db.prepare("DELETE FROM depo_entries WHERE expires_at IS NOT NULL AND expires_at <= ?");
      this.#anyExpired = db.prepare("SELECT 1 FROM depo_entries WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 1");
      this.#setExpiry = db.prepare(
        "UPDATE depo_entries SET expires_at = ? WHERE ns = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      this.#selectMeta = db.prepare("SELECT value FROM depo_meta WHERE key = ?");
      this.#upsertMeta = db.prepare(
        "INSERT INTO depo_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      );
      this.#selectFeatureTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
      const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row["name"]));
      this.#scores = tables.has("depo_scores") ? prepareScores(db) : undefined;
      this.#limits = tables.has("depo_limits") ? prepareLimits(db) : undefined;
      if (!(options.readOnly ?? false)) this.purgeExpired(Date.now());
    } catch (error) {
      this.#conn.close();
      throw error;
    }
  }

  /**
   * Copies the live rows for `keys` (namespace, key pairs) from the Depo file at
   * `path` into this store. The file is read in one snapshot through a
   * read-only connection, which never writes the main file or the WAL and never
   * checkpoints. A file without Depo's schema has nothing to copy.
   */
  copyLiveFrom(path: string, options: ConnectionOptions, keys: Iterable<readonly [string, string]>, now: number): void {
    const source = new Connection(path, { ...options, readOnly: true });
    try {
      source.db.exec("BEGIN");
      const version = readSchemaVersion(source.db);
      if (version === undefined) return;
      checkVersion(path, version);
      const select = source.db.prepare(
        "SELECT value, expires_at FROM depo_entries WHERE ns = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      this.transaction(() => {
        for (const [ns, key] of keys) {
          assertNames(ns, key);
          const row = select.get(ns, key, now);
          if (row !== undefined) this.#upsert.run(ns, key, String(row["value"]), row["expires_at"] ?? null);
        }
      });
    } finally {
      if (source.db.isTransaction) source.db.exec("ROLLBACK");
      source.close();
    }
  }

  #migrate(): void {
    this.#conn.db.exec(`
      CREATE TABLE IF NOT EXISTS depo_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS depo_entries (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (ns, key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS depo_entries_expires_at ON depo_entries (expires_at) WHERE expires_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS depo_scores (
        ns TEXT NOT NULL,
        board TEXT NOT NULL,
        member TEXT NOT NULL,
        score REAL NOT NULL,
        PRIMARY KEY (ns, board, member)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS depo_scores_order ON depo_scores (ns, board, score DESC, member COLLATE BINARY);
      CREATE TABLE IF NOT EXISTS depo_limits (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        tat REAL NOT NULL,
        remainder REAL NOT NULL,
        window REAL NOT NULL,
        PRIMARY KEY (ns, key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS depo_limits_tat ON depo_limits (tat);
    `);
    const version = readSchemaVersion(this.#conn.db);
    if (version === undefined) {
      this.#conn.db
        .prepare("INSERT INTO depo_meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    } else {
      checkVersion(this.path, version);
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    if (this.#pendingBackups > 0) throw new DepoError("Cannot close the database while a backup is pending; await backup() first");
    this.#closed = true;
    this.#conn.close();
  }

  /** Runs one statement; throws a clear error instead of node:sqlite's "statement has been finalized" once closed. */
  #run<T>(fn: () => T): T {
    if (this.#closed) throw new DepoError("The database is closed");
    return this.#conn.run(fn);
  }

  /** Runs `fn` in an immediate transaction (savepoint when nested). */
  transaction<T>(fn: () => T): T {
    if (this.#closed) throw new DepoError("The database is closed");
    return this.#conn.transaction(fn);
  }

  /** Copies the whole connection, including namespaces outside this view. */
  async backup(target: string): Promise<void> {
    if (this.#closed) throw new DepoError("The database is closed");
    if (this.#conn.db.isTransaction) throw new DepoError("Cannot back up inside a transaction; call backup() after the transaction finishes");
    if (typeof target === "string") assertWellFormed("Backup target", target);
    this.#pendingBackups++;
    try {
      await backupDatabase(this.#conn.db, target);
    } finally {
      this.#pendingBackups--;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.#run(() => this.#selectMeta.get(key));
    return row === undefined ? undefined : String(row["value"]);
  }

  setMeta(key: string, value: string): void {
    this.#run(() => this.#upsertMeta.run(key, value));
  }

  /** Returns the live (non-expired) row, or `undefined`. */
  read(ns: string, key: string, now: number): Row | undefined {
    assertNames(ns, key);
    const row = this.#run(() => this.#selectRow.get(ns, key));
    if (row === undefined) return undefined;
    const value = row["value"];
    const expiresAt = row["expires_at"];
    if (typeof value !== "string") throw new DepoError(`Corrupt row ${JSON.stringify(key)}: value is not text`);
    if (typeof expiresAt === "number") {
      return expiresAt > now ? { value, expiresAt } : undefined;
    }
    return { value, expiresAt: null };
  }

  write(ns: string, key: string, json: string, expiresAt: number | null): void {
    assertNames(ns, key);
    this.#run(() => this.#upsert.run(ns, key, json, expiresAt));
  }

  deleteLive(ns: string, key: string, now: number): boolean {
    assertNames(ns, key);
    return Number(this.#run(() => this.#deleteLive.run(ns, key, now)).changes) > 0;
  }

  list(ns: string, now: number, prefix: string, limit: number, after?: string): RawEntry[] {
    return this.#list(ns, now, prefix, limit, after, false)
      .map((row) => ({ key: String(row["key"]), value: String(row["value"]) }));
  }

  keys(ns: string, now: number, prefix: string, limit: number, after?: string): string[] {
    return this.#list(ns, now, prefix, limit, after, true).map((row) => String(row["key"]));
  }

  #list(ns: string, now: number, prefix: string, limit: number, after: string | undefined, keysOnly: boolean) {
    assertWellFormed("Namespace", ns);
    assertWellFormed("Prefix", prefix);
    if (after !== undefined) assertWellFormed("after", after);
    const upper = prefixUpperBound(prefix);
    const statement = keysOnly
      ? upper === undefined ? this.#selectKeys : this.#selectPrefixKeys
      : upper === undefined ? this.#selectAll : this.#selectPrefix;
    const parameters: Record<string, string | number | null> = { ns, now, prefix, after: after ?? null, limit };
    if (upper !== undefined) parameters["upper"] = upper;
    return this.#run(() => statement.all(parameters));
  }

  count(ns: string, now: number): number {
    assertWellFormed("Namespace", ns);
    const row = this.#run(() => this.#countLive.get(ns, now));
    return Number(row?.["n"] ?? 0);
  }

  deleteNamespace(ns: string): void {
    assertWellFormed("Namespace", ns);
    this.#run(() => this.#deleteNamespace.run(ns));
  }

  /** Deletes expired entries and fully refilled limits; takes no write lock when neither exists. */
  purgeExpired(now: number): number {
    const entries = this.#run(() => this.#anyExpired.get(now) !== undefined);
    const limits = this.#run(() => this.#limitStatements?.anyExpired.get(now, now) !== undefined);
    if (!entries && !limits) return 0;
    return this.transaction(() =>
      (entries ? Number(this.#purge.run(now).changes) : 0) +
      (limits ? Number(this.#limits!.purge.run(now, now).changes) : 0),
    );
  }

  setExpiry(ns: string, key: string, expiresAt: number | null, now: number): boolean {
    assertNames(ns, key);
    return Number(this.#run(() => this.#setExpiry.run(expiresAt, ns, key, now)).changes) > 0;
  }

  setScore(ns: string, board: string, member: string, score: number, add: boolean): number {
    return this.#run(() => {
      const statements = this.#scoreStatements;
      if (statements === undefined) throw new DepoError("Cannot write leaderboards on a read-only database");
      const row = (add ? statements.add : statements.set).get(ns, board, member, score);
      if (row === undefined) throw new DepoError(`Result for member ${JSON.stringify(member)} is not a finite number`);
      return Number(row["score"]);
    });
  }

  score(ns: string, board: string, member: string): number | undefined {
    return this.#run(() => {
      const row = this.#scoreStatements?.score.get(ns, board, member);
      return row === undefined ? undefined : Number(row["score"]);
    });
  }

  rank(ns: string, board: string, member: string): number | undefined {
    return this.#run(() => {
      const row = this.#scoreStatements?.rank.get(ns, board, member);
      return row === undefined ? undefined : Number(row["rank"]);
    });
  }

  top(ns: string, board: string, limit: number, offset: number): LeaderboardEntry[] {
    return this.#run(() =>
      (this.#scoreStatements?.top.all(ns, board, Math.min(limit, Number.MAX_SAFE_INTEGER), Math.min(offset, Number.MAX_SAFE_INTEGER)) ?? []).map((row, index) => ({
        member: String(row["member"]),
        score: Number(row["score"]),
        rank: offset + index + 1,
      })),
    );
  }

  removeScore(ns: string, board: string, member: string): boolean {
    return this.#run(() => Number(this.#scoreStatements?.remove.run(ns, board, member).changes ?? 0) > 0);
  }

  countScores(ns: string, board: string): number {
    return this.#run(() => Number(this.#scoreStatements?.count.get(ns, board)?.["n"] ?? 0));
  }

  clearScores(ns: string, board: string): number {
    return this.#run(() => Number(this.#scoreStatements?.clear.run(ns, board).changes ?? 0));
  }

  rateLimit(ns: string, key: string, limit: number, window: number): RateLimitResult {
    return this.transaction(() => {
      const statements = this.#limitStatements;
      if (statements === undefined) throw new DepoError("Cannot write rate limits on a read-only database");
      // Read the wall clock after acquiring the lock, just like TTL read-modify-writes.
      const now = Date.now();
      const row = statements.select.get(ns, key);
      // Split the virtual timestamp into whole milliseconds and a window-scaled
      // remainder: adding tiny intervals directly to epoch milliseconds loses capacity.
      let debt = 0;
      let reset = 0;
      if (row !== undefined) {
        const tat = Number(row["tat"]);
        const remainder = Number(row["remainder"]);
        const previousWindow = Number(row["window"]);
        const elapsed = now - tat;
        if (elapsed >= 0) {
          const outstanding = Math.max(0, remainder - elapsed / previousWindow);
          debt = outstanding === 0 ? 0 : outstanding * (previousWindow / window);
          reset = outstanding * previousWindow;
        } else {
          debt = -elapsed / window + (remainder === 0 ? 0 : remainder * (previousWindow / window));
          reset = -elapsed + remainder * previousWindow;
        }
      }
      const cost = 1 / limit;
      const tolerance = Math.min(cost / 2, Number.EPSILON * limit * 2);
      // Snap arithmetic noise, but preserve genuine fractional-window durations.
      const fraction = window % 1;
      const fractionalPrecision = fraction === 0 ? Infinity : Math.min(fraction, 1 - fraction) / (limit * 4);
      const roundingError = Math.min(fractionalPrecision, 0.25 / limit, Number.EPSILON * Math.max(window, reset, 1) * limit * 8);
      if (debt - (1 - cost) > tolerance) {
        return {
          allowed: false,
          remaining: 0,
          retryAfter: ceilDuration(reset - window * (1 - cost), roundingError),
          resetAfter: ceilDuration(reset, roundingError),
        };
      }
      const next = Math.min(1, debt + cost);
      const duration = next * window;
      const whole = Math.floor(duration);
      statements.upsert.run(ns, key, now + whole, Math.max(0, next - whole / window), window);
      const remaining = Math.max(0, Math.min(limit - 1, Math.floor((1 - next + tolerance) * limit)));
      return { allowed: true, remaining, retryAfter: 0, resetAfter: ceilDuration(duration, roundingError) };
    });
  }

  resetRateLimit(ns: string, key: string): boolean {
    return this.#run(() => Number(this.#limitStatements?.remove.run(ns, key).changes ?? 0) > 0);
  }

  get #scoreStatements(): ScoreStatements | undefined {
    if (this.#scores === undefined && this.#selectFeatureTable.get("depo_scores") !== undefined) {
      this.#scores = prepareScores(this.#conn.db);
    }
    return this.#scores;
  }

  get #limitStatements(): LimitStatements | undefined {
    if (this.#limits === undefined && this.#selectFeatureTable.get("depo_limits") !== undefined) {
      this.#limits = prepareLimits(this.#conn.db);
    }
    return this.#limits;
  }
}

/** Ceil milliseconds without turning floating-point noise above an integer into an extra millisecond. */
function ceilDuration(duration: number, roundingError: number): number {
  const integer = Math.round(duration);
  return Math.max(1, Math.abs(duration - integer) <= roundingError ? integer : Math.ceil(duration));
}

/** Core schema version, independent of additive feature tables. */
function readSchemaVersion(db: SqliteDatabase): number | undefined {
  const objects = db
    .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('depo_meta', 'depo_entries', 'depo_entries_expires_at')")
    .get();
  if (Number(objects?.["n"]) !== 3) return undefined;
  const row = db.prepare("SELECT value FROM depo_meta WHERE key = 'schema_version'").get();
  return row === undefined ? undefined : Number(row["value"]);
}


function hasFeatureSchema(db: SqliteDatabase): boolean {
  const row = db.prepare(
    "SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('depo_scores', 'depo_scores_order', 'depo_limits', 'depo_limits_tat')",
  ).get();
  return Number(row?.["n"]) === 4;
}

interface ScoreStatements {
  set: SqliteStatement;
  add: SqliteStatement;
  score: SqliteStatement;
  rank: SqliteStatement;
  top: SqliteStatement;
  remove: SqliteStatement;
  count: SqliteStatement;
  clear: SqliteStatement;
}

function prepareScores(db: SqliteDatabase): ScoreStatements {
  return {
    set: db.prepare(
      "INSERT INTO depo_scores (ns, board, member, score) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (ns, board, member) DO UPDATE SET score = excluded.score RETURNING score",
    ),
    add: db.prepare(
      "INSERT INTO depo_scores (ns, board, member, score) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (ns, board, member) DO UPDATE SET score = depo_scores.score + excluded.score " +
      "WHERE depo_scores.score + excluded.score BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308 RETURNING score",
    ),
    score: db.prepare("SELECT score FROM depo_scores WHERE ns = ? AND board = ? AND member = ?"),
    rank: db.prepare(
      "SELECT 1 + (SELECT count(*) FROM depo_scores AS higher " +
      "WHERE higher.ns = target.ns AND higher.board = target.board AND higher.score > target.score) " +
      "+ (SELECT count(*) FROM depo_scores AS tied WHERE tied.ns = target.ns AND tied.board = target.board " +
      "AND tied.score = target.score AND tied.member < target.member COLLATE BINARY) AS rank " +
      "FROM depo_scores AS target WHERE ns = ? AND board = ? AND member = ?",
    ),
    top: db.prepare(
      "SELECT member, score FROM depo_scores WHERE ns = ? AND board = ? " +
      "ORDER BY score DESC, member COLLATE BINARY LIMIT ? OFFSET ?",
    ),
    remove: db.prepare("DELETE FROM depo_scores WHERE ns = ? AND board = ? AND member = ?"),
    count: db.prepare("SELECT count(*) AS n FROM depo_scores WHERE ns = ? AND board = ?"),
    clear: db.prepare("DELETE FROM depo_scores WHERE ns = ? AND board = ?"),
  };
}

interface LimitStatements {
  select: SqliteStatement;
  upsert: SqliteStatement;
  remove: SqliteStatement;
  anyExpired: SqliteStatement;
  purge: SqliteStatement;
}

function prepareLimits(db: SqliteDatabase): LimitStatements {
  return {
    select: db.prepare("SELECT tat, remainder, window FROM depo_limits WHERE ns = ? AND key = ?"),
    upsert: db.prepare(
      "INSERT INTO depo_limits (ns, key, tat, remainder, window) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (ns, key) DO UPDATE SET tat = excluded.tat, remainder = excluded.remainder, window = excluded.window",
    ),
    remove: db.prepare("DELETE FROM depo_limits WHERE ns = ? AND key = ?"),
    anyExpired: db.prepare("SELECT 1 FROM depo_limits WHERE tat <= ? AND remainder <= (? - tat) / window LIMIT 1"),
    purge: db.prepare("DELETE FROM depo_limits WHERE tat <= ? AND remainder <= (? - tat) / window"),
  };
}

function checkVersion(path: string, version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new DepoError(
      `${path} uses Depo schema version ${version}; this version of Depo only understands ${SCHEMA_VERSION}. Upgrade Depo.`,
    );
  }
}

/**
 * Throws for a string containing a lone UTF-16 surrogate. SQLite stores TEXT as
 * UTF-8, which cannot represent one: it would be replaced by U+FFFD, so distinct
 * keys (or namespaces) would silently address the same row.
 */
export function assertWellFormed(what: string, name: string): void {
  if (!name.isWellFormed()) {
    throw new DepoError(
      `${what} ${JSON.stringify(name)} contains a lone UTF-16 surrogate; SQLite cannot store it without merging it with other names`,
    );
  }
}

function assertNames(ns: string, key: string): void {
  assertWellFormed("Namespace", ns);
  assertWellFormed("Key", key);
}

/** The smallest well-formed string above every UTF-8 BINARY prefix match. */
function prefixUpperBound(prefix: string): string | undefined {
  for (let end = prefix.length; end > 0;) {
    const last = prefix.charCodeAt(end - 1);
    const start = end - (last >= 0xdc00 && last <= 0xdfff ? 2 : 1);
    const point = prefix.codePointAt(start)!;
    if (point < 0x10ffff) {
      const next = point === 0xd7ff ? 0xe000 : point + 1;
      return prefix.slice(0, start) + String.fromCodePoint(next);
    }
    end = start;
  }
  return undefined;
}

function prepareList(db: SqliteDatabase, bounded: boolean, keysOnly: boolean): SqliteStatement {
  return db.prepare(
    `SELECT ${keysOnly ? "key" : "key, value"} FROM depo_entries ` +
      "WHERE ns = $ns AND key >= max($prefix, coalesce($after, $prefix)) " +
      "AND key IS NOT $after " +
      (bounded ? "AND key < $upper " : "") +
      "AND (expires_at IS NULL OR expires_at > $now) ORDER BY key LIMIT $limit",
  );
}
