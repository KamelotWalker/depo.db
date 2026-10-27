import { isDeepStrictEqual } from "node:util";
import { DepoError } from "./errors.js";
import { Leaderboard } from "./leaderboard.js";
import { deleteIn, formatKey, getIn, parseKey, setIn, typeName, type Key } from "./path.js";
import type { ConnectionOptions } from "./sqlite.js";
import { assertWellFormed, Store } from "./store.js";

export interface DepoOptions extends ConnectionOptions {
  /** Namespace used by this instance. Default `"default"`. See {@link Depo.table}. */
  namespace?: string;
}

export interface SetOptions {
  /** Time to live in milliseconds. Only allowed when setting a whole entry (no path). */
  ttl?: number;
}

export interface AllOptions {
  /** Only return entries whose key starts with this string. */
  prefix?: string;
  /** Maximum number of entries to return. */
  limit?: number;
  /** Exclusive literal entry key from the previous page (not a dot path). */
  after?: string;
}

export interface Entry<T = unknown> {
  key: string;
  value: T;
}

export interface RateLimitOptions {
  /** Maximum burst and number of uses refilled per window. Positive integer. */
  limit: number;
  /** Refill window in milliseconds. Positive finite number. */
  window: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until another use is allowed; zero when allowed. */
  retryAfter: number;
  /** Milliseconds until all capacity is restored. */
  resetAfter: number;
}

export const DEFAULT_PATH = "depo.sqlite";
export const DEFAULT_NAMESPACE = "default";

// Set while `table()` constructs a view so the constructor reuses the parent's connection.
let sharedStore: Store | undefined;

/**
 * Synchronous key-value store backed by one SQLite file.
 *
 * Values are stored as JSON. Every read-modify-write method (`add`, `push`,
 * path `set`, ...) runs in an immediate transaction, so it is atomic even when
 * several processes share the file.
 */
export class Depo {
  readonly #store: Store;
  /** Namespace this instance reads and writes. */
  readonly namespace: string;

  /**
   * @param path SQLite file path, or `":memory:"`. Default `"depo.sqlite"`.
   * The parent directory must exist.
   */
  constructor(path: string = DEFAULT_PATH, options: DepoOptions = {}) {
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    assertNamespace(namespace);
    this.namespace = namespace;
    this.#store = sharedStore ?? new Store(path, options);
  }

  /** Path of the underlying SQLite file. */
  get path(): string {
    return this.#store.path;
  }

  /** Whether the connection is closed. */
  get closed(): boolean {
    return this.#store.closed;
  }

  /**
   * Returns a view of another namespace in the same file, sharing this
   * instance's connection. Keys in different namespaces never collide.
   */
  table(namespace: string): Depo {
    assertNamespace(namespace);
    sharedStore = this.#store;
    try {
      return new Depo(this.#store.path, { namespace });
    } finally {
      sharedStore = undefined;
    }
  }

  /** Returns a sorted set scoped to this namespace, sharing its connection. */
  leaderboard(name: string): Leaderboard {
    return new Leaderboard(this.#store, this.namespace, name);
  }

  /** Atomically consumes one use with smooth GCRA refill. Keys are plain strings, not dot paths. */
  rateLimit(key: string, options: RateLimitOptions): RateLimitResult {
    assertRateLimitKey(key);
    const limit = options?.limit;
    const window = options?.window;
    if (!Number.isInteger(limit) || limit <= 0) throw new DepoError("limit must be a positive integer");
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
      throw new DepoError("window must be a positive finite number of milliseconds");
    }
    return this.#store.rateLimit(this.namespace, key, limit, window);
  }

  /** Removes a rate-limit key's state, restoring its full capacity. */
  resetRateLimit(key: string): boolean {
    assertRateLimitKey(key);
    return this.#store.resetRateLimit(this.namespace, key);
  }

  /** Reads a value. Returns `defaultValue` (or `undefined`) when the key or path does not exist or has expired. */
  get<T = unknown>(key: Key): T | undefined;
  get<T>(key: Key, defaultValue: T): T;
  get(key: Key, defaultValue?: unknown): unknown {
    const [rowKey, ...path] = parseKey(key);
    const row = this.#store.read(this.namespace, rowKey!, Date.now());
    if (row === undefined) return defaultValue;
    const value = getIn(decode(row.value, rowKey!), path);
    return value === undefined ? defaultValue : value;
  }

  /** Whether the key (or path) exists. A stored `null` counts as existing. */
  has(key: Key): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Stores a value and returns it. Setting a whole entry replaces its TTL
   * (no `ttl` option means no expiry). Setting a path keeps the entry's TTL.
   */
  set<T>(key: Key, value: T, options: SetOptions = {}): T {
    const [rowKey, ...path] = parseKey(key);
    assertValue(value, key);
    const ttl = options.ttl;
    if (path.length === 0) {
      const expiresAt = ttl === undefined ? null : expiryFromTtl(ttl);
      this.#store.write(this.namespace, rowKey!, encode(value, rowKey!), expiresAt);
      return value;
    }
    if (ttl !== undefined) {
      throw new DepoError(`TTL applies to whole entries; cannot set a TTL on the path ${formatKey([rowKey!, ...path])}`);
    }
    this.#modify(rowKey!, (root) => setIn(root, rowKey!, path, value));
    return value;
  }

  /** Removes a key or a path. Array elements addressed by index are spliced out. Returns whether anything was removed. */
  delete(key: Key): boolean {
    const [rowKey, ...path] = parseKey(key);
    if (path.length === 0) return this.#store.deleteLive(this.namespace, rowKey!, Date.now());
    let removed = false;
    this.#modify(rowKey!, (root) => {
      removed = deleteIn(root, path);
      return removed ? root : SKIP;
    });
    return removed;
  }

  /** Returns live entries ordered by SQLite BINARY key order, optionally after a literal key. */
  all<T = unknown>(options: AllOptions = {}): Entry<T>[] {
    const { prefix, limit, after } = listOptions(options);
    return this.#store
      .list(this.namespace, Date.now(), prefix, limit, after)
      .map((entry) => ({ key: entry.key, value: decode(entry.value, entry.key) as T }));
  }

  /** Returns live literal entry keys without loading or decoding their JSON values. */
  keys(options: AllOptions = {}): string[] {
    const { prefix, limit, after } = listOptions(options);
    return this.#store.keys(this.namespace, Date.now(), prefix, limit, after);
  }

  /** Number of live entries in this namespace. */
  count(): number {
    return this.#store.count(this.namespace, Date.now());
  }

  /** Removes this namespace's entries, not leaderboards or rate limits. Returns live entries removed. */
  deleteAll(): number {
    return this.#store.transaction(() => {
      const removed = this.#store.count(this.namespace, Date.now());
      this.#store.deleteNamespace(this.namespace);
      return removed;
    });
  }

  /** Atomically adds `amount` to a number (missing counts as 0) and returns the result. */
  add(key: Key, amount: number): number {
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new DepoError("amount must be a finite number");
    }
    const segments = parseKey(key);
    let result = 0;
    this.#modifyAt(segments, (current) => {
      if (current !== undefined && typeof current !== "number") {
        throw new DepoError(`Cannot add to ${formatKey(segments)}: its value is ${typeName(current)}, not a number`);
      }
      result = (current ?? 0) + amount;
      if (!Number.isFinite(result)) throw new DepoError(`Result for ${formatKey(segments)} is not a finite number`);
      return result;
    });
    return result;
  }

  /** Atomically subtracts `amount` from a number (missing counts as 0) and returns the result. */
  subtract(key: Key, amount: number): number {
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new DepoError("amount must be a finite number");
    }
    return this.add(key, -amount);
  }

  /** Atomically appends values to an array (missing counts as `[]`) and returns the new array. */
  push<T = unknown>(key: Key, ...values: T[]): T[] {
    for (const value of values) assertValue(value, key);
    const segments = parseKey(key);
    let result: T[] = [];
    this.#modifyAt(segments, (current) => {
      const array = arrayAt(current, segments, "push to") as T[];
      array.push(...values);
      result = array;
      return array;
    });
    return result;
  }

  /**
   * Atomically removes array elements and returns the remaining array.
   * `match` is either a predicate or a value compared with deep strict equality.
   * A missing key yields `[]` and writes nothing.
   */
  pull<T = unknown>(key: Key, match: T | ((element: T, index: number) => boolean)): T[] {
    const segments = parseKey(key);
    const predicate =
      typeof match === "function"
        ? (match as (element: T, index: number) => boolean)
        : (element: T) => isDeepStrictEqual(element, match);
    let result: T[] = [];
    this.#modifyAt(segments, (current) => {
      if (current === undefined) return SKIP;
      const array = arrayAt(current, segments, "pull from") as T[];
      const kept = array.filter((element, index) => !predicate(element, index));
      result = kept;
      return kept.length === array.length ? SKIP : kept;
    });
    return result;
  }

  /**
   * Remaining time to live of an entry in milliseconds, `null` if it never
   * expires, `undefined` if it does not exist.
   */
  ttl(key: Key): number | null | undefined {
    const rowKey = this.#entryKey(key, "ttl");
    const now = Date.now();
    const row = this.#store.read(this.namespace, rowKey, now);
    if (row === undefined) return undefined;
    return row.expiresAt === null ? null : row.expiresAt - now;
  }

  /** Sets (`ttl` in ms) or clears (`null`) the expiry of an existing entry. Returns whether the entry exists. */
  expire(key: Key, ttl: number | null): boolean {
    const rowKey = this.#entryKey(key, "expire");
    const expiresAt = ttl === null ? null : expiryFromTtl(ttl);
    return this.#store.setExpiry(this.namespace, rowKey, expiresAt, Date.now());
  }

  /**
   * Deletes expired entries and fully refilled rate-limit rows in every namespace,
   * returning the total removed. Expired entries are already invisible to reads;
   * this reclaims their space. Also runs automatically on writable file opens.
   */
  purgeExpired(): number {
    return this.#store.purgeExpired(Date.now());
  }

  /**
   * Runs `fn` in one immediate transaction: all its reads and writes (across
   * namespaces of this file) commit together or not at all. `fn` must be
   * synchronous. Nested calls use savepoints.
   */
  transaction<T>(fn: () => T): T {
    return this.#store.transaction(fn);
  }

  /** Closes the connection. Closes every `table()` view sharing it. */
  close(): void {
    this.#store.close();
  }

  #entryKey(key: Key, method: string): string {
    const [rowKey, ...path] = parseKey(key);
    if (path.length > 0) {
      throw new DepoError(`${method}() applies to whole entries; ${formatKey([rowKey!, ...path])} is a path`);
    }
    return rowKey!;
  }

  /**
   * Read-modify-write of one entry inside an immediate transaction. `fn`
   * receives the decoded value (or `undefined`) and returns the new value, or
   * `SKIP` to leave the entry untouched. The entry's expiry is preserved.
   */
  #modify(rowKey: string, fn: (root: unknown) => unknown): void {
    this.#store.transaction(() => {
      const row = this.#store.read(this.namespace, rowKey, Date.now());
      const root = row === undefined ? undefined : decode(row.value, rowKey);
      const next = fn(root);
      if (next === SKIP) return;
      this.#store.write(this.namespace, rowKey, encode(next, rowKey), row?.expiresAt ?? null);
    });
  }

  /** Like `#modify`, but `fn` receives and returns the value at the key's path. */
  #modifyAt(segments: readonly string[], fn: (current: unknown) => unknown): void {
    const [rowKey, ...path] = segments;
    this.#modify(rowKey!, (root) => {
      const next = fn(getIn(root, path));
      if (next === SKIP) return SKIP;
      return setIn(root, rowKey!, path, next);
    });
  }
}

const SKIP = Symbol("skip");

function assertNamespace(namespace: string): void {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new DepoError("namespace must be a non-empty string");
  }
  assertWellFormed("Namespace", namespace);
}

function assertRateLimitKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new DepoError("Rate-limit key must be a non-empty string");
  assertWellFormed("Rate-limit key", key);
}

function listOptions(options: AllOptions): { prefix: string; limit: number; after: string | undefined } {
  const prefix = options.prefix ?? "";
  const limit = options.limit ?? -1;
  const after = options.after;
  if (typeof prefix !== "string") throw new DepoError("prefix must be a string");
  if (options.limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new DepoError("limit must be a non-negative integer");
  }
  if (after !== undefined && typeof after !== "string") throw new DepoError("after must be a string");
  return { prefix, limit: Math.min(limit, Number.MAX_SAFE_INTEGER), after };
}

/**
 * Rejects values JSON cannot represent. Checked before the value is embedded in
 * an entry (path `set`, `push`), where `JSON.stringify` would silently drop a
 * function or symbol property or turn it into `null` instead of failing.
 */
function assertValue(value: unknown, key: Key): void {
  if (value === undefined) {
    throw new DepoError(`Cannot store undefined at ${typeof key === "string" ? key : formatKey(key)}; use delete() instead`);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new DepoError(
      `Cannot store a ${typeof value} at ${typeof key === "string" ? key : formatKey(key)}: not JSON-serializable`,
    );
  }
}

function expiryFromTtl(ttl: number): number {
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
    throw new DepoError("ttl must be a positive finite number of milliseconds");
  }
  return Date.now() + Math.ceil(ttl);
}

function arrayAt(current: unknown, segments: readonly string[], verb: string): unknown[] {
  if (current === undefined) return [];
  if (!Array.isArray(current)) {
    throw new DepoError(`Cannot ${verb} ${formatKey(segments)}: its value is ${typeName(current)}, not an array`);
  }
  return current;
}

function encode(value: unknown, rowKey: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new DepoError(`Value for ${JSON.stringify(rowKey)} is not JSON-serializable`, { cause: error });
  }
  if (json === undefined) {
    throw new DepoError(`Value for ${JSON.stringify(rowKey)} is not JSON-serializable (${typeof value})`);
  }
  return json;
}

function decode(json: string, rowKey: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new DepoError(`Stored value for ${JSON.stringify(rowKey)} is not valid JSON`, { cause: error });
  }
}
