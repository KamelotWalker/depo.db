import * as sqlite from "node:sqlite";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { DepoError } from "./errors.js";

export type SqliteDatabase = DatabaseSync;
export type SqliteStatement = StatementSync;

type DatabaseConstructor = typeof sqlite.DatabaseSync;

// Node 26.11 renamed `DatabaseSync` to `Database` and kept the old name as a
// documentation-only deprecated alias (DEP0210). Prefer the new name when present.
const DatabaseClass: DatabaseConstructor = resolveDatabaseClass();

function resolveDatabaseClass(): DatabaseConstructor {
  const renamed: unknown = "Database" in sqlite ? sqlite.Database : undefined;
  // The renamed class is the same constructor with the same signature; @types/node 24 does not declare it.
  return typeof renamed === "function" ? (renamed as DatabaseConstructor) : sqlite.DatabaseSync;
}

/**
 * `"full"`: every commit is fsynced; a committed write survives power loss.
 * `"normal"`: in WAL mode commits survive a process crash but the most recent
 * commits may be lost on power loss or OS crash. The file is never corrupted.
 */
export type Synchronous = "full" | "normal";

export interface ConnectionOptions {
  /** Milliseconds to wait for another process's lock before failing with SQLITE_BUSY. Default 5000. */
  busyTimeout?: number;
  /** Durability level, see {@link Synchronous}. Default `"full"`. */
  synchronous?: Synchronous;
  readOnly?: boolean;
}

export const DEFAULT_BUSY_TIMEOUT = 5000;

export function openConnection(path: string, options: ConnectionOptions = {}): SqliteDatabase {
  const busyTimeout = options.busyTimeout ?? DEFAULT_BUSY_TIMEOUT;
  if (!Number.isInteger(busyTimeout) || busyTimeout < 0) {
    throw new DepoError("busyTimeout must be a non-negative integer (milliseconds)");
  }
  const synchronous = options.synchronous ?? "full";
  if (synchronous !== "full" && synchronous !== "normal") {
    throw new DepoError('synchronous must be "full" or "normal"');
  }
  const readOnly = options.readOnly ?? false;
  const db = new DatabaseClass(path, { readOnly, timeout: busyTimeout });
  try {
    // Set explicitly as well: the constructor option is the documented way, the
    // pragma makes the value visible to anyone inspecting the connection.
    db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    if (!readOnly && path !== ":memory:" && path !== "") enableWal(db, busyTimeout);
    db.exec(`PRAGMA synchronous = ${synchronous === "full" ? "FULL" : "NORMAL"}`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Switches the file to WAL mode. Changing the journal mode needs an exclusive
 * lock and SQLite does not run the busy handler for it, so when several
 * processes open a new file at once the switch is retried here until the busy
 * timeout elapses. Files already in WAL mode are left alone without locking.
 */
function enableWal(db: SqliteDatabase, busyTimeout: number): void {
  const deadline = Date.now() + busyTimeout;
  for (let delay = 1; ; delay = Math.min(delay * 2, 50)) {
    try {
      const row = db.prepare("PRAGMA journal_mode").get();
      if (row?.["journal_mode"] === "wal") return;
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(sleepCell, 0, 0, delay);
    }
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), including their extended codes. */
function isBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number") return false;
  const primary = error.errcode & 0xff;
  return primary === 5 || primary === 6;
}

/**
 * Runs callbacks inside write transactions on one connection.
 *
 * The outermost level uses `BEGIN IMMEDIATE`, which takes SQLite's write lock
 * before anything is read. A read-modify-write such as `add` therefore cannot
 * interleave with the same operation in another process: the second process
 * waits (up to the busy timeout) instead of reading a stale value. Nested
 * calls use savepoints so an inner failure only rolls back the inner work.
 */
export class Transactor {
  readonly #db: SqliteDatabase;
  readonly #begin: SqliteStatement;
  readonly #commit: SqliteStatement;
  readonly #rollback: SqliteStatement;
  #depth = 0;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#begin = db.prepare("BEGIN IMMEDIATE");
    this.#commit = db.prepare("COMMIT");
    this.#rollback = db.prepare("ROLLBACK");
  }

  get active(): boolean {
    return this.#depth > 0;
  }

  run<T>(fn: () => T): T {
    if (this.#depth > 0) return this.#runNested(fn);
    this.#begin.run();
    this.#depth = 1;
    let result: T;
    try {
      result = fn();
      assertSync(result);
    } catch (error) {
      this.#depth = 0;
      if (this.#db.isTransaction) this.#rollback.run();
      throw error;
    }
    this.#depth = 0;
    try {
      this.#commit.run();
    } catch (error) {
      if (this.#db.isTransaction) this.#rollback.run();
      throw error;
    }
    return result;
  }

  #runNested<T>(fn: () => T): T {
    const name = `depo_sp_${this.#depth}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    this.#depth++;
    let result: T;
    try {
      result = fn();
      assertSync(result);
    } catch (error) {
      this.#depth--;
      this.#db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
    this.#depth--;
    this.#db.exec(`RELEASE ${name}`);
    return result;
  }
}

function assertSync(result: unknown): void {
  if (typeof result === "object" && result !== null && "then" in result && typeof result.then === "function") {
    throw new DepoError(
      "Transaction callbacks must be synchronous: node:sqlite is synchronous and the transaction would commit before the promise settles",
    );
  }
}

/** Quotes an SQL identifier (table name) for safe interpolation. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
