import { DepoError } from "./errors.js";
import {
  openConnection,
  Transactor,
  type ConnectionOptions,
  type SqliteDatabase,
  type SqliteStatement,
} from "./sqlite.js";

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
 * Schema: a single `depo_entries` table keyed by `(ns, key)`. Namespaces are a
 * column, not separate SQL tables, so no identifier is ever built from user input.
 */
export class Store {
  readonly db: SqliteDatabase;
  readonly tx: Transactor;
  readonly path: string;
  #closed = false;

  readonly #selectRow: SqliteStatement;
  readonly #upsert: SqliteStatement;
  readonly #deleteLive: SqliteStatement;
  readonly #selectAll: SqliteStatement;
  readonly #selectPrefix: SqliteStatement;
  readonly #countLive: SqliteStatement;
  readonly #deleteNamespace: SqliteStatement;
  readonly #purge: SqliteStatement;
  readonly #setExpiry: SqliteStatement;

  constructor(path: string, options: ConnectionOptions) {
    this.path = path;
    this.db = openConnection(path, options);
    try {
      this.tx = new Transactor(this.db);
      this.tx.run(() => this.#migrate());
      this.#selectRow = this.db.prepare("SELECT value, expires_at FROM depo_entries WHERE ns = ? AND key = ?");
      this.#upsert = this.db.prepare(
        "INSERT INTO depo_entries (ns, key, value, expires_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      );
      this.#deleteLive = this.db.prepare(
        "DELETE FROM depo_entries WHERE ns = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      this.#selectAll = this.db.prepare(
        "SELECT key, value FROM depo_entries WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?",
      );
      this.#selectPrefix = this.db.prepare(
        "SELECT key, value FROM depo_entries WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?) " +
          "AND key >= ? AND key < ? ORDER BY key LIMIT ?",
      );
      this.#countLive = this.db.prepare(
        "SELECT count(*) AS n FROM depo_entries WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      this.#deleteNamespace = this.db.prepare("DELETE FROM depo_entries WHERE ns = ?");
      this.#purge = this.db.prepare("DELETE FROM depo_entries WHERE expires_at IS NOT NULL AND expires_at <= ?");
      this.#setExpiry = this.db.prepare(
        "UPDATE depo_entries SET expires_at = ? WHERE ns = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      );
      if (!(options.readOnly ?? false)) this.purgeExpired(Date.now());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  #migrate(): void {
    this.db.exec(`
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
    `);
    const row = this.db.prepare("SELECT value FROM depo_meta WHERE key = 'schema_version'").get();
    if (row === undefined) {
      this.db.prepare("INSERT INTO depo_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      return;
    }
    const version = Number(row["value"]);
    if (version > SCHEMA_VERSION) {
      throw new DepoError(
        `${this.path} uses Depo schema version ${version}; this version of Depo only understands ${SCHEMA_VERSION}. Upgrade Depo.`,
      );
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM depo_meta WHERE key = ?").get(key);
    return row === undefined ? undefined : String(row["value"]);
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO depo_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Returns the live (non-expired) row, or `undefined`. */
  read(ns: string, key: string, now: number): Row | undefined {
    const row = this.#selectRow.get(ns, key);
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
    this.#upsert.run(ns, key, json, expiresAt);
  }

  deleteLive(ns: string, key: string, now: number): boolean {
    return Number(this.#deleteLive.run(ns, key, now).changes) > 0;
  }

  list(ns: string, now: number, prefix: string, limit: number): RawEntry[] {
    const rows =
      prefix === ""
        ? this.#selectAll.all(ns, now, limit)
        : this.#selectPrefix.all(ns, now, prefix, prefixUpperBound(prefix), limit);
    return rows.map((row) => ({ key: String(row["key"]), value: String(row["value"]) }));
  }

  count(ns: string, now: number): number {
    const row = this.#countLive.get(ns, now);
    return Number(row?.["n"] ?? 0);
  }

  deleteNamespace(ns: string): void {
    this.#deleteNamespace.run(ns);
  }

  purgeExpired(now: number): number {
    return Number(this.#purge.run(now).changes);
  }

  setExpiry(ns: string, key: string, expiresAt: number | null, now: number): boolean {
    return Number(this.#setExpiry.run(expiresAt, ns, key, now).changes) > 0;
  }
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
