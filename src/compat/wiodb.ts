/**
 * wio.db v4 compatible `JsonDatabase` on node:sqlite.
 *
 *   const { JsonDatabase } = require("depo/wiodb"); // was: require("wio.db")
 *
 * Data lives in a SQLite file next to the configured JSON path
 * (`databases/db.json` → `databases/db.sqlite`), in Depo's own format and the
 * `default` namespace, so the same file can later be opened with `new Depo()`.
 * On first open an existing wio.db JSON file is imported once; the JSON file is
 * left untouched. Differences from wio.db 4.0.22 are listed in docs/compat-wiodb.md.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DEFAULT_NAMESPACE } from "../depo.js";
import { importEntries, readWioJson } from "../migrate.js";
import type { ConnectionOptions } from "../sqlite.js";
import { Store } from "../store.js";
import { VERSION } from "../version.js";
import { isDeepPath, lodashGet, lodashSet, lodashUnset, stringToPath } from "./lodash-path.js";

const NS = DEFAULT_NAMESPACE;
const IMPORT_META_KEY = "wiodb.json_import";

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

export interface IOptions extends ConnectionOptions {
  /** wio.db JSON path. Default `"databases/db.json"`. The SQLite file uses the same name with `.sqlite`. */
  databasePath?: string;
  /** Maximum number of top-level keys. */
  maxDataSize?: number | null;
  /** Import the JSON file at `databasePath` on first open. Default `true`. */
  importJson?: boolean;
}

export interface Schema<T> {
  ID: string;
  data: T;
}

export interface IInfo {
  version: string;
  size: number;
}

type MathOperator = "+" | "-" | "*" | "/" | "%";

function assertKey(key: unknown): asserts key is string {
  if (key === "" || typeof key !== "string") throw new DatabaseError("Unapproved key!");
}

function assertAutoWrite(autoWrite: unknown): void {
  if (typeof autoWrite !== "boolean") throw new DatabaseError("autoWrite parameter must be true or false!");
}

/** Resolves wio.db's `databasePath` rules: `.json` is appended, a trailing separator means `db.json`. */
function resolveJsonPath(databasePath: string): string {
  let file = databasePath;
  if (!file.endsWith(".json")) file += file.endsWith("/") || file.endsWith(sep) ? "db.json" : ".json";
  return resolve(file);
}

export class JsonDatabase<V> {
  /** Path of the SQLite file holding the data. */
  readonly path: string;
  /** wio.db JSON path this database was configured with (only read for the one-time import). */
  readonly jsonPath: string;
  maxDataSize: number | null;
  readonly #store: Store;

  constructor({ databasePath = "databases/db.json", maxDataSize = null, importJson = true, ...connection }: IOptions = {}) {
    if (maxDataSize !== null && typeof maxDataSize !== "number") {
      throw new DatabaseError("The maximum limit must be in number type!");
    }
    if (maxDataSize !== null && maxDataSize < 1) {
      throw new DatabaseError("Inappropriate range for the limit!");
    }
    this.jsonPath = resolveJsonPath(databasePath);
    this.path = this.jsonPath.slice(0, -".json".length) + ".sqlite";
    this.maxDataSize = maxDataSize;
    mkdirSync(dirname(this.path), { recursive: true });
    this.#store = new Store(this.path, connection);
    try {
      this.#importOnce(importJson);
    } catch (error) {
      this.#store.close();
      throw error;
    }
  }

  /** Imports the wio.db JSON file into an empty database, once per SQLite file. Race-free across processes. */
  #importOnce(importJson: boolean): void {
    const store = this.#store;
    store.transaction(() => {
      if (store.getMeta(IMPORT_META_KEY) !== undefined) return;
      let imported = 0;
      if (importJson && existsSync(this.jsonPath) && store.count(NS, Date.now()) === 0) {
        const group = readWioJson(this.jsonPath, NS);
        imported = importEntries(store, NS, group.entries, false, Date.now()).inserted;
      }
      store.setMeta(IMPORT_META_KEY, JSON.stringify({ from: this.jsonPath, entries: imported, at: new Date().toISOString() }));
    });
  }

  /** Number of top-level keys. */
  get size(): number {
    return this.#store.count(NS, Date.now());
  }

  get info(): IInfo {
    return { size: this.size, version: VERSION };
  }

  /** Splits a wio.db key into the top-level key and the lodash path below it. */
  #resolve(key: string): [string, string[]] {
    if (!isDeepPath(key) || this.#store.read(NS, key, Date.now()) !== undefined) return [key, []];
    const [first, ...rest] = stringToPath(key);
    return first === undefined ? [key, []] : [first, rest];
  }

  #readRow(rowKey: string): unknown {
    const row = this.#store.read(NS, rowKey, Date.now());
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  #writeRow(rowKey: string, value: unknown): void {
    this.#store.write(NS, rowKey, JSON.stringify(value), null);
  }

  set(key: string, value: V, autoWrite = true): V {
    assertKey(key);
    const raw: unknown = value;
    if (raw === "" || raw === undefined || raw === null) throw new DatabaseError("Unapproved value!");
    assertAutoWrite(autoWrite);
    return this.#store.transaction(() => {
      const [rowKey, rest] = this.#resolve(key);
      const current = this.#readRow(rowKey);
      if (current === undefined && this.maxDataSize !== null && this.size >= this.maxDataSize) {
        throw new DatabaseError("Data limit exceeded!");
      }
      if (rest.length === 0) {
        this.#writeRow(rowKey, value);
        return value;
      }
      const wrapper: Record<string, unknown> = { [rowKey]: current };
      lodashSet(wrapper, [rowKey, ...rest], value);
      const next = wrapper[rowKey];
      if (next !== undefined) this.#writeRow(rowKey, next);
      return value;
    });
  }

  get(key: string, defaultValue: V | null = null): V {
    assertKey(key);
    const [rowKey, rest] = this.#resolve(key);
    const root = this.#readRow(rowKey);
    const data = rest.length === 0 ? root : lodashGet(root, rest);
    return (data === undefined ? defaultValue : data) as V;
  }

  fetch(key: string, defaultValue?: V): V {
    return this.get(key, defaultValue);
  }

  exists(key: string): boolean {
    return this.#store.read(NS, String(key), Date.now()) !== undefined;
  }

  has(key: string): boolean {
    return this.exists(key);
  }

  all(limit = 0): Array<Schema<V>> {
    if (typeof limit !== "number") throw new DatabaseError("Must be of limit number type!");
    const max = limit > 0 ? Math.trunc(limit) : -1;
    return this.#store
      .list(NS, Date.now(), "", max)
      .map((entry) => ({ ID: entry.key, data: JSON.parse(entry.value) as V }));
  }

  fetchAll(limit?: number): Array<Schema<V>> {
    return this.all(limit);
  }

  toJSON(limit?: number): { [key: string]: V } {
    const json: { [key: string]: V } = {};
    for (const element of this.all(limit)) {
      Object.defineProperty(json, element.ID, { value: element.data, enumerable: true, writable: true, configurable: true });
    }
    return json;
  }

  delete(key: string, autoWrite = true): void {
    assertKey(key);
    assertAutoWrite(autoWrite);
    this.#store.transaction(() => {
      const [rowKey, rest] = this.#resolve(key);
      if (rest.length === 0) {
        this.#store.deleteLive(NS, rowKey, Date.now());
        return;
      }
      const current = this.#readRow(rowKey);
      if (current === undefined) return;
      const wrapper: Record<string, unknown> = { [rowKey]: current };
      lodashUnset(wrapper, [rowKey, ...rest]);
      this.#writeRow(rowKey, wrapper[rowKey]);
    });
  }

  deleteAll(): void {
    this.#store.deleteNamespace(NS);
  }

  type(key: string): "string" | "number" | "bigint" | "boolean" | "symbol" | "array" | "undefined" | "object" | "function" {
    const data = this.get(key);
    return Array.isArray(data) ? "array" : typeof data;
  }

  pull(
    key: string,
    // `any` mirrors wio.db's published signature so existing typed callbacks keep compiling.
    callbackfn: (element: any, index: number, array: Array<any>) => boolean,
    multiple = false,
    thisArg?: unknown,
  ): V | false {
    return this.#store.transaction(() => {
      const data: unknown = this.get(key);
      if (!data) return false;
      if (!Array.isArray(data)) throw new DatabaseError(`${key} It is not a data string with an ID.`);
      if (typeof multiple !== "boolean") throw new DatabaseError("multiple parameter must be true or false!");
      const predicate = thisArg ? callbackfn.bind(thisArg) : callbackfn;
      if (multiple) {
        return this.set(key, data.filter((element, index, array) => !predicate(element, index, array)) as V);
      }
      const index = data.findIndex(predicate);
      if (index !== -1) data.splice(index, 1);
      return this.set(key, data as V);
    });
  }

  valueArray(): V[] {
    return this.all().map((element) => element.data);
  }

  keyArray(): string[] {
    return this.all().map((element) => element.ID);
  }

  math(key: string, operator: MathOperator, value: number, goToNegative = false): V {
    const raw: unknown = value;
    if (Array.isArray(raw) || Number.isNaN(Number(raw))) throw new DatabaseError("The type of value is not a number.");
    if (Number(raw) <= 0) throw new DatabaseError("Value cannot be less than 1.");
    const amount = Number(raw);
    if (typeof goToNegative !== "boolean") throw new DatabaseError("The goToNegative parameter must be of boolean type.");
    return this.#store.transaction(() => {
      const data: unknown = this.get(key);
      let current = 0;
      if (data) {
        if (Array.isArray(data) || Number.isNaN(Number(data))) {
          throw new DatabaseError(`${key} ID data is not a number type data.`);
        }
        current = Number(data);
      }
      switch (operator) {
        case "+":
          current += amount;
          break;
        case "-":
          current -= amount;
          if (!goToNegative && current < 1) current = 0;
          break;
        case "*":
          current *= amount;
          break;
        case "/":
          current /= amount;
          break;
        case "%":
          current %= amount;
          break;
      }
      return this.set(key, current as V);
    });
  }

  add(key: string, value: number): V {
    return this.math(key, "+", value);
  }

  substr(key: string, value: number, goToNegative?: boolean): V {
    return this.math(key, "-", value, goToNegative);
  }

  push(key: string, value: unknown): V {
    return this.#store.transaction(() => {
      const data: unknown = this.get(key);
      if (data && Array.isArray(data)) {
        data.push(value);
        return this.set(key, data as V);
      }
      return this.set(key, [value] as V);
    });
  }

  includes(key: string): Array<Schema<V>> {
    return this.filter((element) => element.ID.includes(key));
  }

  startsWith(key: string): Array<Schema<V>> {
    return this.filter((element) => element.ID.startsWith(key));
  }

  filter(callbackfn: (value: Schema<V>, index: number, array: Array<Schema<V>>) => boolean, thisArg?: unknown): Array<Schema<V>> {
    return this.all().filter(thisArg ? callbackfn.bind(thisArg) : callbackfn);
  }

  sort(callbackfn: (a: Schema<V>, b: Schema<V>) => number, thisArg?: unknown): Array<Schema<V>> {
    return this.all().sort(thisArg ? callbackfn.bind(thisArg) : callbackfn);
  }

  /** Closes the database and deletes the SQLite file (and its WAL/SHM files). The JSON file is not touched. */
  destroy(): void {
    this.#store.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(this.path + suffix, { force: true });
  }

  findAndDelete(callbackfn: (element: Schema<V>, provider: this) => boolean, thisArg?: unknown): number {
    const predicate = thisArg ? callbackfn.bind(thisArg) : callbackfn;
    return this.#store.transaction(() => {
      let deleted = 0;
      for (const element of this.all()) {
        if (predicate(element, this)) {
          this.delete(element.ID);
          deleted++;
        }
      }
      return deleted;
    });
  }

  /** Closes the connection (not part of wio.db's API, which keeps no open handle). */
  close(): void {
    this.#store.close();
  }
}
