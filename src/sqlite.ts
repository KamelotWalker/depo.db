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
  /** Milliseconds to wait for another connection's lock before failing with SQLITE_BUSY. Default 5000. */
  busyTimeout?: number;
  /** Durability level, see {@link Synchronous}. Default `"full"`. */
  synchronous?: Synchronous;
  readOnly?: boolean;
}

export const DEFAULT_BUSY_TIMEOUT = 5000;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), including their extended codes. */
function isBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number") return false;
  const primary = error.errcode & 0xff;
  return primary === 5 || primary === 6;
}

/**
 * Calls `fn`, retrying while it fails with SQLITE_BUSY, for up to `timeoutMs`.
 *
 * Used instead of SQLite's built-in busy handler, whose back-off grows to
 * 100 ms sleeps: under sustained writes from several processes a waiter that
 * only wakes every 100 ms rarely finds the lock free and can starve for
 * seconds. Polling every ~1-2 ms (with jitter) keeps waits short.
 * Only use for operations that change nothing when they fail with SQLITE_BUSY.
 * The deadline uses the monotonic clock: a wall-clock adjustment must not stretch or cut the wait.
 */
function retryBusy<T>(fn: () => T, timeoutMs: number): T {
  let deadline: number | undefined;
  for (;;) {
    try {
      return fn();
    } catch (error) {
      if (!isBusy(error)) throw error;
      const now = performance.now();
      deadline ??= now + timeoutMs;
      if (now >= deadline) throw error;
      Atomics.wait(sleepCell, 0, 0, 1 + Math.random());
    }
  }
}

/**
 * One SQLite connection configured for Depo: WAL journal, chosen synchronous
 * level, busy retries, and write transactions.
 *
 * Transactions use `BEGIN IMMEDIATE`, which takes SQLite's write lock before
 * anything is read. A read-modify-write such as `add` therefore cannot
 * interleave with the same operation in another process: the second process
 * waits (up to the busy timeout) instead of reading a stale value. Nested
 * calls use savepoints so an inner failure only rolls back the inner work.
 */
export class Connection {
  readonly db: SqliteDatabase;
  readonly busyTimeout: number;
  readonly #begin: SqliteStatement;
  readonly #commit: SqliteStatement;
  readonly #rollback: SqliteStatement;
  #depth = 0;

  /**
   * @param preview Dry-run mode: the journal mode is left unchanged and
   * everything runs inside one immediate transaction that `close()` rolls back,
   * so nothing done through this connection reaches the file.
   */
  constructor(path: string, options: ConnectionOptions = {}, preview = false) {
    const busyTimeout = options.busyTimeout ?? DEFAULT_BUSY_TIMEOUT;
    if (!Number.isInteger(busyTimeout) || busyTimeout < 0) {
      throw new DepoError("busyTimeout must be a non-negative integer (milliseconds)");
    }
    const synchronous = options.synchronous ?? "full";
    if (synchronous !== "full" && synchronous !== "normal") {
      throw new DepoError('synchronous must be "full" or "normal"');
    }
    const readOnly = options.readOnly ?? false;
    this.busyTimeout = busyTimeout;
    // Writable connections handle SQLITE_BUSY in `retryBusy` (see there), so
    // SQLite's own handler is off. Read-only connections never compete for the
    // write lock and keep SQLite's handler.
    this.db = new DatabaseClass(path, { readOnly, timeout: readOnly ? busyTimeout : 0 });
    try {
      if (!readOnly && !preview && path !== ":memory:" && path !== "") {
        // Changing the journal mode needs an exclusive lock; retried when several processes open a new file at once.
        retryBusy(() => {
          const row = this.db.prepare("PRAGMA journal_mode").get();
          if (row?.["journal_mode"] !== "wal") this.db.exec("PRAGMA journal_mode = WAL");
        }, busyTimeout);
      }
      this.db.exec(`PRAGMA synchronous = ${synchronous === "full" ? "FULL" : "NORMAL"}`);
      this.#begin = this.db.prepare("BEGIN IMMEDIATE");
      this.#commit = this.db.prepare("COMMIT");
      this.#rollback = this.db.prepare("ROLLBACK");
      if (preview) {
        retryBusy(() => this.#begin.run(), busyTimeout);
        this.#depth = 1;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Runs a single statement. Outside a transaction it is its own (autocommit)
   * transaction and is retried on SQLITE_BUSY; inside one the lock is already held.
   */
  run<T>(fn: () => T): T {
    return this.#depth > 0 ? fn() : retryBusy(fn, this.busyTimeout);
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return this.#nested(fn);
    retryBusy(() => this.#begin.run(), this.busyTimeout);
    this.#depth = 1;
    let result: T;
    try {
      result = fn();
      assertSync(result);
    } catch (error) {
      this.#depth = 0;
      if (this.db.isTransaction) this.#rollback.run();
      throw error;
    }
    this.#depth = 0;
    try {
      retryBusy(() => this.#commit.run(), this.busyTimeout);
    } catch (error) {
      if (this.db.isTransaction) this.#rollback.run();
      throw error;
    }
    return result;
  }

  #nested<T>(fn: () => T): T {
    const name = `depo_sp_${this.#depth}`;
    this.db.exec(`SAVEPOINT ${name}`);
    this.#depth++;
    let result: T;
    try {
      result = fn();
      assertSync(result);
    } catch (error) {
      this.#depth--;
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
    this.#depth--;
    this.db.exec(`RELEASE ${name}`);
    return result;
  }

  /** Closes the connection; an open transaction (always the case in preview mode) is rolled back. */
  close(): void {
    if (this.db.isTransaction) this.#rollback.run();
    this.db.close();
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
