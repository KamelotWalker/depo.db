import { ZulaError } from "./errors.js";
import { Connection, type ConnectionOptions, type SqliteDatabase, type SqliteStatement } from "./sqlite.js";

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
 * One SQLite connection plus the prepared statements for Zula's schema.
 * Shared by every namespace view (`Zula#table`) opened from the same `Zula`.
 *
 * Schema: a single `zula_entries` table keyed by `(ns, key)`. Namespaces are a
 * column, not separate SQL tables, so no identifier is ever built from user input.
 */
export class Store {
  readonly path: string;
  readonly #conn: Connection;
  #closed = false;

  readonly #selectRow: SqliteStatement;
  readonly #upsert: SqliteStatement;
  readonly #deleteLive: SqliteStatement;
  readonly #selectAll: SqliteStatement;
  readonly #selectPrefix: SqliteStatement;
  readonly #countLive: SqliteStatement;
  readonly #deleteNamespace: SqliteStatement;
  readonly #purge: SqliteStatement;
  readonly #anyExpired: SqliteStatement;
  readonly #setExpiry: SqliteStatement;
  readonly #selectMeta: SqliteStatement;
  readonly #upsertMeta: SqliteStatement;

  constructor(path: string, options: ConnectionOptions) {
    this.path = path;
    this.#conn = new Connection(path, options);
    const db = this.#conn.db;
    try {
      // Opening an existing file takes no write lock: under heavy write traffic from other
      // processes a late opener would otherwise have to win the lock just to start.
      const version = this.#conn.run(() => readSchemaVersion(db));
      if (version === undefined) this.#conn.transaction(() => this.#migrate());
      else checkVersion(path, version);
      this.#selectRow = db.prepare("SELECT value, expires_at FROM zula_entries WHERE ns = ? AND key = ?");
      this.#upsert = db.prepare(
        "INSERT INTO zula_entries (ns, key, value, expires_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      );
      this.#deleteLive = db.prepare(
        "DELETE FROM zula_entries WHERE ns = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      this.#selectAll = db.prepare(
        "SELECT key, value FROM zula_entries WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?",
      );
      this.#selectPrefix = db.prepare(
        "SELECT key, value FROM zula_entries WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?) " +
          "AND key >= ? AND key < ? ORDER BY key LIMIT ?",
      );
      this.#countLive = db.prepare(
        "SELECT count(*) AS n FROM zula_entries WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      this.#deleteNamespace = db.prepare("DELETE FROM zula_entries WHERE ns = ?");
      this.#purge = db.prepare("DELETE FROM zula_entries WHERE expires_at IS NOT NULL AND expires_at <= ?");
      this.#anyExpired = db.prepare("SELECT 1 FROM zula_entries WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 1");
      this.#setExpiry = db.prepare(
        "UPDATE zula_entries SET expires_at = ? WHERE ns = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      this.#selectMeta = db.prepare("SELECT value FROM zula_meta WHERE key = ?");
      this.#upsertMeta = db.prepare(
        "INSERT INTO zula_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      );
      if (!(options.readOnly ?? false)) this.purgeExpired(Date.now());
    } catch (error) {
      this.#conn.close();
      throw error;
    }
  }

  /**
   * Copies the live rows for `keys` (namespace, key pairs) from the Zula file at
   * `path` into this store. The file is read in one snapshot through a
   * read-only connection, which never writes the main file or the WAL and never
   * checkpoints. A file without Zula's schema has nothing to copy.
   */
  copyLiveFrom(path: string, options: ConnectionOptions, keys: Iterable<readonly [string, string]>, now: number): void {
    const source = new Connection(path, { ...options, readOnly: true });
    try {
      source.db.exec("BEGIN");
      const version = readSchemaVersion(source.db);
      if (version === undefined) return;
      checkVersion(path, version);
      const select = source.db.prepare(
        "SELECT value, expires_at FROM zula_entries WHERE ns = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
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
      CREATE TABLE IF NOT EXISTS zula_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS zula_entries (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (ns, key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS zula_entries_expires_at ON zula_entries (expires_at) WHERE expires_at IS NOT NULL;
    `);
    const version = readSchemaVersion(this.#conn.db);
    if (version === undefined) {
      this.#conn.db
        .prepare("INSERT INTO zula_meta (key, value) VALUES ('schema_version', ?)")
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
    this.#closed = true;
    this.#conn.close();
  }

  /** Runs one statement; throws a clear error instead of node:sqlite's "statement has been finalized" once closed. */
  #run<T>(fn: () => T): T {
    if (this.#closed) throw new ZulaError("The database is closed");
    return this.#conn.run(fn);
  }

  /** Runs `fn` in an immediate transaction (savepoint when nested). */
  transaction<T>(fn: () => T): T {
    if (this.#closed) throw new ZulaError("The database is closed");
    return this.#conn.transaction(fn);
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
    if (typeof value !== "string") throw new ZulaError(`Corrupt row ${JSON.stringify(key)}: value is not text`);
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

  list(ns: string, now: number, prefix: string, limit: number): RawEntry[] {
    assertWellFormed("Namespace", ns);
    assertWellFormed("Prefix", prefix);
    const rows = this.#run(() =>
      prefix === ""
        ? this.#selectAll.all(ns, now, limit)
        : this.#selectPrefix.all(ns, now, prefix, prefixUpperBound(prefix), limit),
    );
    return rows.map((row) => ({ key: String(row["key"]), value: String(row["value"]) }));
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

  /** Deletes expired rows in every namespace. Takes no write lock when nothing has expired. */
  purgeExpired(now: number): number {
    return this.#run(() => (this.#anyExpired.get(now) === undefined ? 0 : Number(this.#purge.run(now).changes)));
  }

  setExpiry(ns: string, key: string, expiresAt: number | null, now: number): boolean {
    assertNames(ns, key);
    return Number(this.#run(() => this.#setExpiry.run(expiresAt, ns, key, now)).changes) > 0;
  }
}

/** Schema version when all of Zula's tables exist, else `undefined`. */
function readSchemaVersion(db: SqliteDatabase): number | undefined {
  const objects = db
    .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('zula_meta', 'zula_entries', 'zula_entries_expires_at')")
    .get();
  if (Number(objects?.["n"]) !== 3) return undefined;
  const row = db.prepare("SELECT value FROM zula_meta WHERE key = 'schema_version'").get();
  return row === undefined ? undefined : Number(row["value"]);
}

function checkVersion(path: string, version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new ZulaError(
      `${path} uses Zula schema version ${version}; this version of Zula only understands ${SCHEMA_VERSION}. Upgrade Zula.`,
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
    throw new ZulaError(
      `${what} ${JSON.stringify(name)} contains a lone UTF-16 surrogate; SQLite cannot store it without merging it with other names`,
    );
  }
}

function assertNames(ns: string, key: string): void {
  assertWellFormed("Namespace", ns);
  assertWellFormed("Key", key);
}

/**
 * Exclusive upper bound for keys starting with `prefix` under SQLite's BINARY
 * collation (UTF-8 byte order): `prefix` followed by U+10FFFF, the largest code
 * point. Keys that continue the prefix with U+10FFFF itself (a noncharacter that
 * does not occur in real keys) fall outside the range.
 */
function prefixUpperBound(prefix: string): string {
  return prefix + "\u{10FFFF}";
}
