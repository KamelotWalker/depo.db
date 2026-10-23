/**
 * quick.db v9 compatible API on node:sqlite.
 *
 *   const { QuickDB } = require("zula/quickdb"); // was: require("quick.db")
 *
 * Reads and writes quick.db's own on-disk format (a `json.sqlite` file with one
 * `(ID TEXT PRIMARY KEY, json TEXT)` table per quick.db table), so an existing
 * quick.db file keeps working without conversion, and the file stays readable
 * by quick.db. Differences from quick.db 9.1.7 are listed in docs/compat-quickdb.md.
 */
import { Connection, quoteIdentifier, type ConnectionOptions, type SqliteDatabase, type SqliteStatement } from "../sqlite.js";
import { castPath, lodashGet, lodashSet, lodashUnset } from "./lodash-path.js";

export interface IQuickDBOptions {
  table?: string;
  filePath?: string;
  /** Only Zula's own {@link SqliteDriver} / {@link MemoryDriver} are accepted. */
  driver?: SqliteDriver;
  normalKeys?: boolean;
}

interface TableStatements {
  selectAll: SqliteStatement;
  selectOne: SqliteStatement;
  upsert: SqliteStatement;
  deleteAll: SqliteStatement;
  deleteOne: SqliteStatement;
}

/** quick.db's `SqliteDriver`, implemented on node:sqlite instead of better-sqlite3. */
export class SqliteDriver {
  private static instance: SqliteDriver | null = null;
  readonly #conn: Connection;
  readonly #tables = new Map<string, TableStatements>();

  get database(): SqliteDatabase {
    return this.#conn.db;
  }

  constructor(path: string, options: ConnectionOptions = {}) {
    this.#conn = new Connection(path, options);
  }

  static createSingleton(path: string): SqliteDriver {
    SqliteDriver.instance ??= new SqliteDriver(path);
    return SqliteDriver.instance;
  }

  async prepare(table: string): Promise<void> {
    this.prepareSync(table);
  }

  async getAllRows(table: string): Promise<{ id: string; value: unknown }[]> {
    return this.allSync(table);
  }

  async getRowByKey<T>(table: string, key: string): Promise<[T | null, boolean]> {
    return this.readSync(table, key) as [T | null, boolean];
  }

  async setRowByKey<T>(table: string, key: string, value: T, _update: boolean): Promise<T> {
    this.writeSync(table, key, value);
    return value;
  }

  async deleteAllRows(table: string): Promise<number> {
    return this.deleteAllSync(table);
  }

  async deleteRowByKey(table: string, key: string): Promise<number> {
    return this.deleteSync(table, key);
  }

  /** Closes the connection (not part of quick.db's driver API). */
  close(): void {
    this.#conn.close();
  }

  /** @internal */
  prepareSync(table: string): void {
    if (this.#tables.has(table)) return;
    const name = quoteIdentifier(table);
    const db = this.#conn.db;
    // Check first so opening an existing table takes no write lock.
    this.#conn.run(() => {
      const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
      if (exists === undefined) db.exec(`CREATE TABLE IF NOT EXISTS ${name} (ID TEXT PRIMARY KEY, json TEXT)`);
    });
    this.#tables.set(table, {
      selectAll: db.prepare(`SELECT ID, json FROM ${name}`),
      selectOne: db.prepare(`SELECT json FROM ${name} WHERE ID = ?`),
      upsert: db.prepare(`INSERT INTO ${name} (ID, json) VALUES (?, ?) ON CONFLICT (ID) DO UPDATE SET json = excluded.json`),
      deleteAll: db.prepare(`DELETE FROM ${name}`),
      deleteOne: db.prepare(`DELETE FROM ${name} WHERE ID = ?`),
    });
  }

  #statements(table: string): TableStatements {
    let statements = this.#tables.get(table);
    if (statements === undefined) {
      this.prepareSync(table);
      statements = this.#tables.get(table)!;
    }
    return statements;
  }

  /** @internal */
  allSync(table: string): { id: string; value: unknown }[] {
    const statement = this.#statements(table).selectAll;
    return this.#conn
      .run(() => statement.all())
      .map((row) => ({ id: String(row["ID"]), value: parseJson(row["json"]) }));
  }

  /** @internal */
  readSync(table: string, key: string): [unknown, boolean] {
    const statement = this.#statements(table).selectOne;
    const row = this.#conn.run(() => statement.get(key));
    return row === undefined ? [null, false] : [parseJson(row["json"]), true];
  }

  /** @internal */
  writeSync(table: string, key: string, value: unknown): void {
    const statement = this.#statements(table).upsert;
    const json = JSON.stringify(value);
    this.#conn.run(() => statement.run(key, json));
  }

  /** @internal */
  deleteAllSync(table: string): number {
    const statement = this.#statements(table).deleteAll;
    return Number(this.#conn.run(() => statement.run()).changes);
  }

  /** @internal */
  deleteSync(table: string, key: string): number {
    const statement = this.#statements(table).deleteOne;
    return Number(this.#conn.run(() => statement.run(key)).changes);
  }

  /** @internal Runs `fn` in an immediate transaction. */
  transaction<T>(fn: () => T): T {
    return this.#conn.transaction(fn);
  }
}

/** quick.db's `MemoryDriver`: here an in-memory SQLite database. */
export class MemoryDriver extends SqliteDriver {
  constructor() {
    super(":memory:");
  }
}

function parseJson(text: unknown): unknown {
  return text == null ? null : JSON.parse(String(text));
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key != "string") throw new Error("First argument (key) needs to be a string");
}

// `any` is quick.db's own public default for D; `unknown` would break existing TypeScript callers.
export class QuickDB<D = any> {
  private static instance: QuickDB | undefined;
  private prepared: Promise<void>;
  readonly #driver: SqliteDriver;
  readonly #tableName: string;
  #normalKeys: boolean;
  readonly #options: IQuickDBOptions;

  get driver(): SqliteDriver {
    return this.#driver;
  }

  constructor(options: IQuickDBOptions = {}) {
    if (options.driver !== undefined && !(options.driver instanceof SqliteDriver)) {
      throw new Error("zula/quickdb only supports its own SqliteDriver and MemoryDriver");
    }
    const table = options.table ?? "json";
    const driver = options.driver ?? new SqliteDriver(options.filePath ?? "json.sqlite");
    this.#options = { ...options, table, driver };
    this.#driver = driver;
    this.#tableName = table;
    this.#normalKeys = options.normalKeys ?? false;
    driver.prepareSync(table);
    this.prepared = Promise.resolve();
  }

  static createSingleton<T>(options: IQuickDBOptions = {}): QuickDB<T> {
    QuickDB.instance ??= new QuickDB(options);
    return QuickDB.instance as QuickDB<T>;
  }

  async init(): Promise<void> {
    await this.prepared;
  }

  async all<T = D>(): Promise<{ id: string; value: T }[]> {
    return this.#driver.allSync(this.#tableName) as { id: string; value: T }[];
  }

  async get<T = D>(key: string): Promise<T | null> {
    return this.#get(key) as T | null;
  }

  async set<T = D>(key: string, value: T): Promise<T> {
    return this.#driver.transaction(() => this.#set(key, value)) as T;
  }

  async has(key: string): Promise<boolean> {
    return this.#get(key) != null;
  }

  async delete(key: string): Promise<number> {
    assertKey(key);
    const split = this.#split(key);
    if (split === undefined) return this.#driver.deleteSync(this.#tableName, key);
    const [rowKey, subPath] = split;
    // quick.db returns the updated parent object here, despite the declared `number`.
    return this.#driver.transaction(() => {
      const object: unknown = this.#get(rowKey) ?? {};
      lodashUnset(object, castPath(subPath, object));
      return this.#set(rowKey, object);
    }) as number;
  }

  async deleteAll(): Promise<number> {
    return this.#driver.deleteAllSync(this.#tableName);
  }

  async add(key: string, value: number): Promise<number> {
    return this.#addSubtract(key, value, false);
  }

  async sub(key: string, value: number): Promise<number> {
    return this.#addSubtract(key, value, true);
  }

  async push<T = D>(key: string, ...values: T[]): Promise<T[]> {
    assertKey(key);
    if (values.length === 0) throw new Error("Missing second argument (value)");
    return this.#driver.transaction(() => {
      const array = this.#getArray(key);
      array.push(...values);
      return this.#set(key, array);
    }) as T[];
  }

  async unshift<T = D>(key: string, value: T | T[]): Promise<T[]> {
    assertKey(key);
    if (value == null) throw new Error("Missing second argument (value)");
    return this.#driver.transaction(() => {
      let array = this.#getArray(key) as T[];
      if (Array.isArray(value)) array = value.concat(array);
      else array.unshift(value);
      return this.#set(key, array);
    }) as T[];
  }

  async pop<T = D>(key: string): Promise<T | undefined> {
    assertKey(key);
    return this.#driver.transaction(() => {
      const array = this.#getArray(key);
      const value = array.pop();
      this.#set(key, array);
      return value;
    }) as T | undefined;
  }

  async shift<T = D>(key: string): Promise<T | undefined> {
    assertKey(key);
    return this.#driver.transaction(() => {
      const array = this.#getArray(key);
      const value = array.shift();
      this.#set(key, array);
      return value;
    }) as T | undefined;
  }

  async pull<T = D>(key: string, value: T | T[] | ((data: T, index: string) => boolean), once = false): Promise<T[]> {
    assertKey(key);
    if (value == null) throw new Error("Missing second argument (value)");
    const matches =
      typeof value == "function"
        ? (value as (data: T, index: string) => boolean)
        : ((list: unknown[]) => (data: T) => list.includes(data))(Array.isArray(value) ? value : [value]);
    return this.#driver.transaction(() => {
      const array = this.#getArray(key) as T[];
      const kept: T[] = [];
      let removed = false;
      for (const index in array) {
        const element = array[index]!;
        if (!(once && removed) && matches(element, index)) {
          removed = true;
          continue;
        }
        kept.push(element);
      }
      return this.#set(key, kept);
    }) as T[];
  }

  async startsWith<T = D>(query: string, key = ""): Promise<{ id: string; value: T }[]> {
    if (typeof query != "string") throw new Error("First argument (query) needs to be a string");
    if (typeof key != "string") throw new Error("Second argument (key) needs to be a string");
    const source = (key === "" ? this.#driver.allSync(this.#tableName) : (this.#get(key) ?? [])) as { id: string; value: T }[];
    return source.filter((entry) => entry.id.startsWith(query));
  }

  table<T = D>(table: string): QuickDB<T> {
    if (typeof table != "string") throw new Error("First argument (table) needs to be a string");
    return new QuickDB<T>({ ...this.#options, table, driver: this.#driver });
  }

  async tableAsync(table: string): Promise<QuickDB> {
    const db = this.table(table);
    await db.prepared;
    return db;
  }

  useNormalKeys(activate: boolean): void {
    this.#normalKeys = activate;
  }

  /** Splits `"row.path"` into the row ID and the lodash path, or `undefined` for a plain key. */
  #split(key: string): [string, string] | undefined {
    if (this.#normalKeys) return undefined;
    const dot = key.indexOf(".");
    return dot === -1 ? undefined : [key.slice(0, dot), key.slice(dot + 1)];
  }

  #get(key: string): unknown {
    assertKey(key);
    const split = this.#split(key);
    if (split === undefined) return this.#driver.readSync(this.#tableName, key)[0];
    const [rowKey, subPath] = split;
    const [row] = this.#driver.readSync(this.#tableName, rowKey);
    return lodashGet(row, castPath(subPath, row));
  }

  /** Must run inside a transaction when it reads (dotted keys). */
  #set(key: string, value: unknown): unknown {
    assertKey(key);
    if (value == null) throw new Error("Missing second argument (value)");
    const split = this.#split(key);
    if (split === undefined) {
      this.#driver.writeSync(this.#tableName, key, value);
      return value;
    }
    const [rowKey, subPath] = split;
    const [row] = this.#driver.readSync(this.#tableName, rowKey);
    const object = row instanceof Object ? row : {};
    lodashSet(object, castPath(subPath, object), value);
    this.#driver.writeSync(this.#tableName, rowKey, object);
    return object;
  }

  #getArray(key: string): unknown[] {
    const current = this.#get(key) ?? [];
    if (!Array.isArray(current)) throw new Error(`Current value with key: (${key}) is not an array`);
    return current;
  }

  #addSubtract(key: string, value: number, sub: boolean): number {
    assertKey(key);
    if (value == null) throw new Error("Missing second argument (value)");
    return this.#driver.transaction(() => {
      const stored = this.#get(key) ?? 0;
      let current = typeof stored == "number" ? stored : parseFloat(String(stored));
      const amount = typeof value == "number" ? value : parseFloat(String(value));
      current = sub ? current - amount : current + amount;
      this.#set(key, current);
      return current;
    });
  }
}
