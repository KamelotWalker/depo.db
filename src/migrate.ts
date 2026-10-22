import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_NAMESPACE } from "./depo.js";
import { DepoError } from "./errors.js";
import { Connection, quoteIdentifier, type ConnectionOptions } from "./sqlite.js";
import { Store } from "./store.js";

/** One entry to import: the row key, its value as JSON text, and an absolute expiry. */
export interface SourceEntry {
  key: string;
  json: string;
  expiresAt: number | null;
}

export interface SourceGroup {
  /** Origin inside the source, e.g. a quick.db table name or the JSON file. */
  origin: string;
  namespace: string;
  entries: SourceEntry[];
  /** Notes about data that could not be carried over. */
  warnings: string[];
}

export type SourceFormat = "wio" | "croxydb" | "quickdb";

export interface ImportStats {
  read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  conflicts: number;
}

export interface GroupReport extends ImportStats {
  origin: string;
  namespace: string;
  warnings: string[];
}

export interface MigrationReport {
  source: string;
  format: SourceFormat;
  target: string;
  dryRun: boolean;
  groups: GroupReport[];
  total: ImportStats;
}

export interface MigrationOptions {
  source: string;
  /** Detected from the file header when omitted: SQLite → quickdb, otherwise wio JSON. */
  format?: SourceFormat;
  /** Target Depo file. Default `depo.sqlite`. */
  target?: string;
  /** Namespace for JSON sources. Default `"default"`. */
  namespace?: string;
  /** quick.db tables to import. Default: every table with quick.db's `(ID, json)` layout. */
  tables?: string[];
  /** Replace target entries whose value differs. Default `false`: keep them and count a conflict. */
  overwrite?: boolean;
  /** Compute the report inside a transaction that is rolled back. */
  dryRun?: boolean;
  /** Connection options for the target file. */
  connection?: ConnectionOptions;
  /** Clock for TTL handling (tests). */
  now?: number;
}

const SQLITE_HEADER = "SQLite format 3\u0000";
const CROXYDB_ENCRYPTION_PREFIX = "croxydb:v1:";

/** quick.db's default table name; imported into Depo's default namespace. */
const QUICKDB_DEFAULT_TABLE = "json";

export function detectFormat(file: string): SourceFormat {
  const head = readFileSync(file).subarray(0, SQLITE_HEADER.length).toString("latin1");
  return head === SQLITE_HEADER ? "quickdb" : "wio";
}

function readJsonText(file: string): string {
  const text = readFileSync(file, "utf8");
  // Tolerate a UTF-8 BOM written by some editors.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseJsonObject(text: string, file: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = text.trim() === "" ? {} : JSON.parse(text);
  } catch (error) {
    throw new DepoError(`${file} is not valid JSON`, { cause: error });
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new DepoError(`${file} must contain a JSON object at the top level`);
  }
  // Copy into a typed record; Object.fromEntries keeps a literal "__proto__" key as an own property.
  return Object.fromEntries(Object.entries(data));
}

function toEntries(data: Record<string, unknown>): SourceEntry[] {
  return Object.keys(data).map((key) => ({ key, json: JSON.stringify(data[key]), expiresAt: null }));
}

/**
 * wio.db `JsonDatabase` file: one JSON object whose top-level properties are the
 * keys (wio.db's dot-notation writes nested objects under the first segment).
 */
export function readWioJson(file: string, namespace: string = DEFAULT_NAMESPACE): SourceGroup {
  return { origin: file, namespace, entries: toEntries(parseJsonObject(readJsonText(file), file)), warnings: [] };
}

/**
 * croxydb `jsondb` adapter file. Same layout as wio.db. TTLs live in a sidecar
 * `<name>.ttl.json` mapping keys to absolute expiry timestamps; TTLs of
 * top-level keys are carried over, already-expired keys are skipped.
 */
export function readCroxyJson(file: string, namespace: string = DEFAULT_NAMESPACE, now: number = Date.now()): SourceGroup {
  const text = readJsonText(file);
  if (text.startsWith(CROXYDB_ENCRYPTION_PREFIX)) {
    throw new DepoError(
      `${file} is encrypted by croxydb (encryptionKey). Open it with croxydb, call setEncryptionKey(null) to rewrite it unencrypted, then migrate.`,
    );
  }
  const data = parseJsonObject(text, file);
  const warnings: string[] = [];
  const ttlFile = file.replace(/\.json$/i, "") + ".ttl.json";
  const expiries = new Map<string, number>();
  if (existsSync(ttlFile)) {
    const ttlText = readJsonText(ttlFile);
    if (ttlText.startsWith(CROXYDB_ENCRYPTION_PREFIX)) {
      throw new DepoError(`${ttlFile} is encrypted by croxydb; decrypt the database first.`);
    }
    for (const [key, expiresAt] of Object.entries(parseJsonObject(ttlText, ttlFile))) {
      if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) continue;
      if (Object.hasOwn(data, key)) expiries.set(key, expiresAt);
      else warnings.push(`TTL on nested key ${JSON.stringify(key)} not carried over (Depo TTLs apply to whole entries)`);
    }
  }
  const entries: SourceEntry[] = [];
  for (const entry of toEntries(data)) {
    const expiresAt = expiries.get(entry.key);
    if (expiresAt === undefined) {
      entries.push(entry);
    } else if (expiresAt > now) {
      entries.push({ ...entry, expiresAt });
    } else {
      warnings.push(`Skipped ${JSON.stringify(entry.key)}: already expired`);
    }
  }
  return { origin: file, namespace, entries, warnings };
}

/**
 * quick.db `json.sqlite` file: one `(ID TEXT PRIMARY KEY, json TEXT)` table per
 * quick.db table. Table `json` maps to the `default` namespace, any other table
 * to the namespace of the same name.
 */
export function readQuickDb(file: string, tables?: readonly string[]): SourceGroup[] {
  const conn = new Connection(file, { readOnly: true });
  const db = conn.db;
  try {
    // One read transaction: every table is read from the same snapshot even if a quick.db process is writing.
    db.exec("BEGIN");
    // `_` is a LIKE wildcard: escape it so only SQLite's reserved `sqlite_` prefix is excluded, not e.g. `sqliteData`.
    const available = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
      .all()
      .map((row) => String(row["name"]))
      .filter((name) => {
        const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all().map((row) => String(row["name"]));
        return columns.includes("ID") && columns.includes("json");
      });
    const selected = tables === undefined || tables.length === 0 ? available : [...tables];
    for (const table of selected) {
      if (!available.includes(table)) {
        throw new DepoError(`${file} has no quick.db table ${JSON.stringify(table)} (found: ${available.join(", ") || "none"})`);
      }
    }
    return selected.map((table) => {
      const warnings: string[] = [];
      const entries: SourceEntry[] = [];
      for (const row of db.prepare(`SELECT ID, json FROM ${quoteIdentifier(table)}`).iterate()) {
        const key = String(row["ID"]);
        const json = row["json"];
        if (typeof json !== "string") {
          warnings.push(`Skipped ${JSON.stringify(key)}: json column is ${json === null ? "NULL" : typeof json}`);
          continue;
        }
        let value: unknown;
        try {
          value = JSON.parse(json);
        } catch (error) {
          throw new DepoError(`quick.db row ${JSON.stringify(key)} in table ${JSON.stringify(table)} is not valid JSON`, {
            cause: error,
          });
        }
        entries.push({ key, json: JSON.stringify(value), expiresAt: null });
      }
      const namespace = table === QUICKDB_DEFAULT_TABLE ? DEFAULT_NAMESPACE : table;
      return { origin: `table ${table}`, namespace, entries, warnings };
    });
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    conn.close();
  }
}

/** Writes entries into one namespace. Must run inside a transaction. */
export function importEntries(
  store: Store,
  namespace: string,
  entries: readonly SourceEntry[],
  overwrite: boolean,
  now: number,
): ImportStats {
  const stats: ImportStats = { read: entries.length, inserted: 0, updated: 0, unchanged: 0, conflicts: 0 };
  for (const entry of entries) {
    const existing = store.read(namespace, entry.key, now);
    if (existing === undefined) {
      store.write(namespace, entry.key, entry.json, entry.expiresAt);
      stats.inserted++;
    } else if (existing.value === entry.json && existing.expiresAt === entry.expiresAt) {
      stats.unchanged++;
    } else if (overwrite) {
      store.write(namespace, entry.key, entry.json, entry.expiresAt);
      stats.updated++;
    } else {
      stats.conflicts++;
    }
  }
  return stats;
}

/** Imports a wio.db / croxydb JSON file or a quick.db SQLite file into a Depo file. Idempotent. */
export function runMigration(options: MigrationOptions): MigrationReport {
  const source = options.source;
  if (!existsSync(source)) throw new DepoError(`Source file not found: ${source}`);
  const format = options.format ?? detectFormat(source);
  const target = options.target ?? "depo.sqlite";
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const now = options.now ?? Date.now();
  if (format === "quickdb" && options.namespace !== undefined) {
    throw new DepoError("--namespace applies to JSON sources; quick.db tables map to namespaces by name");
  }
  if (format !== "quickdb" && options.tables !== undefined && options.tables.length > 0) {
    throw new DepoError("--table applies to quick.db sources only");
  }
  const groups =
    format === "quickdb"
      ? readQuickDb(source, options.tables)
      : [format === "croxydb" ? readCroxyJson(source, namespace, now) : readWioJson(source, namespace)];

  const dryRun = options.dryRun ?? false;
  const connection = options.connection ?? {};
  const targetExists = existsSync(target);
  const hasSidecars = existsSync(`${target}-wal`) || existsSync(`${target}-shm`);
  // Dry runs never change the target:
  // - missing target: an empty in-memory store stands in, so the file is not created;
  // - target with a -wal/-shm (another process has it open, or a writer exited without closing): its live
  //   entries are copied into an in-memory store through a read-only connection. A writable connection would
  //   checkpoint the WAL into the main file when it closes as the last connection;
  // - otherwise: preview mode, where opening (schema creation, expired-row purge) and the import run in one
  //   transaction that close() rolls back. Unlike a read-only connection it leaves no -wal/-shm behind.
  const preview = dryRun && targetExists && !hasSidecars;
  const store = new Store(dryRun && !preview ? ":memory:" : target, connection, preview);
  const reports: GroupReport[] = [];
  try {
    if (dryRun && targetExists && hasSidecars) {
      store.copyLiveFrom(target, connection, groups.map((group) => group.namespace), now);
    }
    store.transaction(() => {
      for (const group of groups) {
        const stats = importEntries(store, group.namespace, group.entries, options.overwrite ?? false, now);
        reports.push({ origin: group.origin, namespace: group.namespace, warnings: group.warnings, ...stats });
      }
    });
  } finally {
    store.close();
  }

  const total: ImportStats = { read: 0, inserted: 0, updated: 0, unchanged: 0, conflicts: 0 };
  for (const report of reports) {
    total.read += report.read;
    total.inserted += report.inserted;
    total.updated += report.updated;
    total.unchanged += report.unchanged;
    total.conflicts += report.conflicts;
  }
  return { source, format, target, dryRun, groups: reports, total };
}
