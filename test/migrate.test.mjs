import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { Depo } from "../dist/esm/index.js";
import { readCroxyJson, runMigration } from "../dist/esm/migrate.js";
import { CLI, FIXTURES, sleep, tempDir } from "./helpers.mjs";

function depo(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function migrateJson(...args) {
  const run = depo("migrate", ...args, "--json");
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function readAll(file, namespace) {
  const db = new Depo(file, namespace ? { namespace } : {});
  try {
    return Object.fromEntries(db.all().map((e) => [e.key, e.value]));
  } finally {
    db.close();
  }
}

test("wio.db JSON: imports every top-level key, idempotent on re-run", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "depo.sqlite");
  const source = join(FIXTURES, "wio", "db.json");
  const expected = JSON.parse(readFileSync(source, "utf8"));
  const keys = Object.keys(expected).length;

  const first = migrateJson(source, "--to", target);
  assert.equal(first.format, "wio");
  assert.deepEqual(first.total, { read: keys, inserted: keys, updated: 0, unchanged: 0, conflicts: 0 });
  assert.deepStrictEqual(readAll(target), { ...expected });

  const second = migrateJson(source, "--to", target);
  assert.deepEqual(second.total, { read: keys, inserted: 0, updated: 0, unchanged: keys, conflicts: 0 });
  assert.deepStrictEqual(readAll(target), { ...expected });
});

test("wio.db JSON: human-readable report and --namespace", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "depo.sqlite");
  const run = depo("migrate", join(FIXTURES, "wio", "db.json"), "--to", target, "--namespace", "legacy");
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /namespace "legacy": read 11, inserted 11, updated 0, unchanged 0, conflicts 0/);
  assert.match(run.stdout, /^Total: read 11, inserted 11/m);
  assert.deepEqual(readAll(target), {});
  assert.equal(readAll(target, "legacy").money_111, 750);
});

test("conflicts are kept by default and replaced with --overwrite", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "depo.sqlite");
  const source = join(FIXTURES, "wio", "db.json");
  const db = new Depo(target);
  db.set("money_111", 1);
  db.set("unrelated", true);
  db.close();

  const kept = migrateJson(source, "--to", target);
  assert.equal(kept.total.conflicts, 1);
  assert.equal(kept.total.inserted, 10);
  assert.equal(readAll(target).money_111, 1);
  const human = depo("migrate", source, "--to", target);
  assert.match(human.stdout, /Re-run with --overwrite/);

  const replaced = migrateJson(source, "--to", target, "--overwrite");
  assert.equal(replaced.total.updated, 1);
  assert.equal(replaced.total.conflicts, 0);
  assert.equal(readAll(target).money_111, 750);
  assert.equal(readAll(target).unrelated, true, "keys absent from the source are left alone");
});

test("--dry-run reports without writing", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "depo.sqlite");
  const report = migrateJson(join(FIXTURES, "wio", "db.json"), "--to", target, "--dry-run");
  assert.equal(report.dryRun, true);
  assert.equal(report.total.inserted, 11);
  assert.equal(existsSync(target), false, "a dry run does not create the target");
});

test("--dry-run leaves an existing target byte-for-byte unchanged", async (t) => {
  const dir = tempDir(t);
  const source = join(dir, "source.json");
  writeFileSync(source, JSON.stringify({ fresh: 1, live: 2 }));
  // A Depo target with an expired row: opening it normally purges that row.
  const target = join(dir, "depo.sqlite");
  const db = new Depo(target);
  db.set("expired", 123, { ttl: 1 });
  db.set("live", 456);
  db.close();
  await sleep(20);
  // A foreign SQLite file (rollback journal, no Depo schema): a real run adds the schema and switches it to WAL.
  const foreign = join(dir, "foreign.sqlite");
  const raw = new DatabaseSync(foreign);
  raw.exec("CREATE TABLE other (x); INSERT INTO other VALUES (1)");
  raw.close();

  for (const [file, total] of [
    [target, { read: 2, inserted: 1, updated: 0, unchanged: 0, conflicts: 1 }],
    [foreign, { read: 2, inserted: 2, updated: 0, unchanged: 0, conflicts: 0 }],
  ]) {
    const before = readFileSync(file);
    const report = migrateJson(source, "--to", file, "--dry-run");
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.total, total);
    assert.ok(before.equals(readFileSync(file)), `${file} is unchanged`);
    assert.equal(existsSync(`${file}-wal`), false, "no WAL file left behind");
  }
  const check = new DatabaseSync(target, { readOnly: true });
  assert.deepEqual(
    check.prepare("SELECT key, value FROM depo_entries ORDER BY key").all().map((row) => [row.key, row.value]),
    [
      ["expired", "123"],
      ["live", "456"],
    ],
  );
  check.close();
});

test("quick.db SQLite: auto-detected, every table imported, json → default", (t) => {
  const dir = tempDir(t);
  const source = join(dir, "json.sqlite");
  copyFileSync(join(FIXTURES, "quickdb", "json.sqlite"), source);
  const target = join(dir, "depo.sqlite");

  const first = migrateJson(source, "--to", target);
  assert.equal(first.format, "quickdb");
  assert.deepEqual(
    first.groups.map((g) => [g.origin, g.namespace, g.read, g.inserted]),
    [
      ["table economy", "economy", 2, 2],
      ["table json", "default", 7, 7],
    ],
  );
  assert.deepStrictEqual(readAll(target), {
    money_111: 750,
    user_111: { name: "Ayşe", level: 8 },
    inventory_111: ["kılıç", "kalkan"],
    text: "merhaba dünya",
    flag: false,
    nested: { a: { b: { c: [1, { d: null }] } } },
    "dotted.key": "literal",
  });
  assert.deepStrictEqual(readAll(target, "economy"), { bank_111: 900, bank_222: 50 });
  const db = new Depo(target);
  assert.equal(db.get("dotted\\.key"), "literal", "literal dotted IDs stay addressable with escaping");
  db.close();

  const second = migrateJson(source, "--to", target);
  assert.deepEqual(second.total, { read: 9, inserted: 0, updated: 0, unchanged: 9, conflicts: 0 });
});

test("quick.db SQLite: --table selects tables; unknown tables fail", (t) => {
  const dir = tempDir(t);
  const source = join(dir, "json.sqlite");
  copyFileSync(join(FIXTURES, "quickdb", "json.sqlite"), source);
  const target = join(dir, "depo.sqlite");
  const report = migrateJson(source, "--to", target, "--table", "economy");
  assert.deepEqual(report.groups.map((g) => g.namespace), ["economy"]);
  const missing = depo("migrate", source, "--to", target, "--table", "nope");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no quick.db table "nope" \(found: economy, json\)/);
  const misuse = depo("migrate", source, "--to", target, "--namespace", "x");
  assert.equal(misuse.code, 1);
  assert.match(misuse.stderr, /--namespace applies to JSON sources/);
});

test("quick.db SQLite: tables whose names only resemble sqlite_ are imported", (t) => {
  const dir = tempDir(t);
  const source = join(dir, "json.sqlite");
  const raw = new DatabaseSync(source);
  // quick.db's table layout. In LIKE, `_` matches any character, so 'sqlite_%' also matched these names.
  for (const table of ["json", "sqliteData", "sqlite1"]) raw.exec(`CREATE TABLE ${table} (ID TEXT PRIMARY KEY, json TEXT)`);
  raw.exec(
    "INSERT INTO json VALUES ('ordinary', '1'); INSERT INTO sqliteData VALUES ('balance', '900'); INSERT INTO sqlite1 VALUES ('x', 'true')",
  );
  raw.close();
  const target = join(dir, "depo.sqlite");

  const report = migrateJson(source, "--to", target);
  assert.deepEqual(
    report.groups.map((g) => [g.origin, g.namespace, g.inserted]),
    [
      ["table json", "default", 1],
      ["table sqlite1", "sqlite1", 1],
      ["table sqliteData", "sqliteData", 1],
    ],
  );
  assert.deepEqual(readAll(target, "sqliteData"), { balance: 900 });
  assert.deepEqual(readAll(target, "sqlite1"), { x: true });
  const selected = migrateJson(source, "--to", join(dir, "selected.sqlite"), "--table", "sqliteData");
  assert.deepEqual(selected.groups.map((g) => g.namespace), ["sqliteData"]);
});

test("croxydb JSON: same layout as wio.db; TTL sidecar carried over for top-level keys", (t) => {
  const dir = tempDir(t);
  cpSync(join(FIXTURES, "croxydb"), dir, { recursive: true });
  const source = join(dir, "croxydb.json");
  const target = join(dir, "depo.sqlite");

  const report = migrateJson(source, "--from", "croxydb", "--to", target);
  assert.equal(report.total.inserted, 6);
  assert.deepEqual(report.groups[0].warnings, [
    'TTL on nested key "cooldown.312345678901234567" not carried over (Depo TTLs apply to whole entries)',
  ]);
  const db = new Depo(target);
  assert.deepEqual(db.get("session_111"), { token: "abc" });
  const ttl = db.ttl("session_111");
  assert.ok(Math.abs(Date.now() + ttl - Date.UTC(2099, 0, 1)) < 5_000, "absolute expiry preserved");
  assert.equal(db.ttl("money_111"), null);
  assert.equal(db.get("user.312345678901234567.name"), "Ayşe");
  db.close();

  // Without --from croxydb the file is read as plain wio.db JSON (no TTLs).
  const plain = migrateJson(source, "--to", join(dir, "plain.sqlite"));
  assert.equal(plain.format, "wio");
  const plainDb = new Depo(join(dir, "plain.sqlite"));
  assert.equal(plainDb.ttl("session_111"), null);
  plainDb.close();

  const again = migrateJson(source, "--from", "croxydb", "--to", target);
  assert.deepEqual(again.total, { read: 6, inserted: 0, updated: 0, unchanged: 6, conflicts: 0 });
});

test("croxydb JSON: already-expired keys are skipped", () => {
  const group = readCroxyJson(join(FIXTURES, "croxydb", "croxydb.json"), "default", Date.UTC(2100, 0, 1));
  assert.equal(group.entries.some((e) => e.key === "session_111"), false);
  assert.ok(group.warnings.includes('Skipped "session_111": already expired'));
});

test("croxydb JSON: encrypted files are refused with instructions", (t) => {
  const dir = tempDir(t);
  const source = join(dir, "croxydb.json");
  writeFileSync(source, "croxydb:v1:aaaa:bbbb:cccc");
  const run = depo("migrate", source, "--from", "croxydb", "--to", join(dir, "depo.sqlite"));
  assert.equal(run.code, 1);
  assert.match(run.stderr, /encrypted by croxydb/);
});

test("bad input fails with exit code 1 and a one-line message", (t) => {
  const dir = tempDir(t);
  const cases = [
    [["migrate", join(dir, "nope.json")], /Source file not found/],
    [["migrate"], /Missing <source>/],
    [["frobnicate", "x"], /Unknown command "frobnicate"/],
    [["migrate", join(FIXTURES, "wio", "db.json"), "--from", "mongo"], /--from must be one of/],
    [["migrate", join(FIXTURES, "wio", "db.json"), "--bogus"], /Unknown option '--bogus'/],
  ];
  writeFileSync(join(dir, "array.json"), "[1,2]");
  writeFileSync(join(dir, "broken.json"), "{oops");
  cases.push([["migrate", join(dir, "array.json"), "--to", join(dir, "t.sqlite")], /must contain a JSON object/]);
  cases.push([["migrate", join(dir, "broken.json"), "--to", join(dir, "t.sqlite")], /is not valid JSON/]);
  for (const [args, message] of cases) {
    const run = depo(...args);
    assert.equal(run.code, 1, args.join(" "));
    assert.match(run.stderr, message);
    assert.doesNotMatch(run.stderr, /\n\s+at /, "no stack trace for expected errors");
  }
});

test("--help and --version", () => {
  const help = depo("--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: depo migrate <source>/);
  const version = depo("--version");
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
});

test("programmatic runMigration writes nothing for an empty JSON object", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "empty.json"), "{}");
  const report = runMigration({ source: join(dir, "empty.json"), target: join(dir, "t.sqlite") });
  assert.deepEqual(report.total, { read: 0, inserted: 0, updated: 0, unchanged: 0, conflicts: 0 });
  assert.equal(existsSync(join(dir, "t.sqlite")), true);
});
