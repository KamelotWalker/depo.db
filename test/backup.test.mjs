import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Depo, DepoError } from "../dist/esm/index.js";
import { CLI, onCleanup, tempDir } from "./helpers.mjs";

function open(t, file, options) {
  const db = new Depo(file, options);
  onCleanup(t, () => db.close());
  return db;
}

function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

test("backup through a table preserves the entire database, features, metadata and absolute TTLs", async (t) => {
  const dir = tempDir(t);
  const db = open(t, join(dir, "source.sqlite"));
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  db.set("root", { count: 42 });
  db.set("expires", "short-lived", { ttl: 1000 });
  const guild = db.table("guild.1");
  guild.set("root", "other namespace");
  guild.leaderboard("xp").set("winner", 42.5);
  db.leaderboard("coins").set("member", -3);
  const limit = { limit: 1, window: 60_000 };
  guild.rateLimit("command", limit);
  const raw = new DatabaseSync(db.path);
  try { raw.prepare("INSERT INTO depo_meta VALUES (?, ?)").run("custom", "preserved"); }
  finally { raw.close(); }

  const target = join(dir, "backup.sqlite");
  await guild.backup(target);
  now += 400;
  const copy = open(t, target);
  assert.deepEqual(copy.get("root"), { count: 42 });
  assert.equal(copy.table("guild.1").get("root"), "other namespace");
  assert.deepEqual(copy.table("guild.1").leaderboard("xp").top(), [{ member: "winner", score: 42.5, rank: 1 }]);
  assert.equal(copy.leaderboard("coins").score("member"), -3);
  assert.equal(copy.table("guild.1").rateLimit("command", limit).allowed, false);
  assert.equal(copy.ttl("expires"), 600);
  const inspection = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(inspection.prepare("SELECT value FROM depo_meta WHERE key = 'custom'").get().value, "preserved");
    assert.equal(inspection.prepare("SELECT expires_at FROM depo_entries WHERE key = 'expires'").get().expires_at, 1_800_000_001_000);
    assert.equal(inspection.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { inspection.close(); }
  now += 600;
  assert.equal(copy.get("expires"), undefined);
  assert.equal(db.get("expires"), undefined);
  copy.set("independent", true);
  assert.equal(db.has("independent"), false);
});

test("backup includes committed WAL pages from a second connection while the writer stays open", async (t) => {
  const dir = tempDir(t);
  const db = open(t, join(dir, "source.sqlite"));
  const writer = new DatabaseSync(db.path);
  onCleanup(t, () => writer.close());
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  writer.prepare("INSERT INTO depo_entries (ns, key, value) VALUES (?, ?, ?)").run("peer", "wal-only", JSON.stringify({ committed: true }));
  assert.ok(statSync(`${db.path}-wal`).size > 32, "committed WAL frames remain while both connections are open");
  const target = join(dir, "backup.sqlite");
  await db.backup(target);
  const copy = open(t, target, { readOnly: true });
  assert.deepEqual(copy.table("peer").get("wal-only"), { committed: true });
  assert.equal(copy.table("default").get("wal-only"), undefined);
});

test("backup never overwrites source, files, directories, hard links or dangling symbolic links", async (t) => {
  const dir = tempDir(t);
  const db = open(t, join(dir, "source.sqlite"));
  db.set("safe", true);
  const sourceBefore = readFileSync(db.path);
  await assert.rejects(db.backup(db.path), /source database/);
  await assert.rejects(db.backup(join(dir, ".", "source.sqlite")), /source database/);
  await assert.rejects(db.backup(`${db.path}-wal`), /sidecar/);
  assert.deepEqual(readFileSync(db.path), sourceBefore);
  assert.equal(db.get("safe"), true);

  const existing = join(dir, "existing.sqlite");
  const bytes = Buffer.from([0, 1, 255, 20, 42]);
  writeFileSync(existing, bytes);
  await assert.rejects(db.backup(existing), /already exists/);
  assert.deepEqual(readFileSync(existing), bytes);
  const directory = join(dir, "directory");
  mkdirSync(directory);
  writeFileSync(join(directory, "keep"), "untouched");
  await assert.rejects(db.backup(directory), DepoError);
  assert.equal(readFileSync(join(directory, "keep"), "utf8"), "untouched");
  assert.equal(lstatSync(directory).isDirectory(), true);

  const hardLink = join(dir, "hard-link.sqlite");
  linkSync(db.path, hardLink);
  await assert.rejects(db.backup(hardLink), /already exists/);
  assert.deepEqual(readFileSync(hardLink), sourceBefore);
  const symlink = join(dir, "dangling.sqlite");
  const missing = join(dir, "not-created.sqlite");
  try {
    symlinkSync(missing, symlink);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.diagnostic("Symbolic-link case unavailable without Windows symlink permission; file/directory/hard-link cases covered");
      return;
    }
    throw error;
  }
  await assert.rejects(db.backup(symlink), /already exists/);
  assert.equal(readlinkSync(symlink), missing);
  assert.equal(existsSync(missing), false);
});

test("backup protects absent source sidecars across case variants and source/target path aliases", async (t) => {
  const dir = tempDir(t);
  const actual = join(dir, "actual");
  mkdirSync(actual);
  const source = join(actual, "MixedCase.sqlite");
  const seed = open(t, source);
  seed.set("safe", true);
  seed.close();
  const raw = new DatabaseSync(source);
  try { raw.exec("PRAGMA journal_mode = DELETE"); }
  finally { raw.close(); }
  const before = readFileSync(source);
  const db = open(t, source, { readOnly: true });
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    assert.equal(existsSync(`${source}${suffix}`), false);
    if (process.platform === "win32") {
      const mixedCaseTarget = join(actual, `MIXEDCASE.SQLITE${suffix.toUpperCase()}`);
      await assert.rejects(db.backup(mixedCaseTarget), /source database.*sidecar/);
      assert.equal(existsSync(mixedCaseTarget), false);
    }
  }

  const directoryAlias = join(dir, "directory-alias");
  try {
    // Directory junctions do not require Windows file-symlink privilege.
    symlinkSync(actual, directoryAlias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.diagnostic("Directory-alias cases unavailable without filesystem link permission");
      assert.deepEqual(readFileSync(source), before);
      return;
    }
    throw error;
  }
  const aliasedSource = join(directoryAlias, "MixedCase.sqlite");
  const throughDirectory = open(t, aliasedSource, { readOnly: true });
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    await assert.rejects(throughDirectory.backup(`${source}${suffix}`), /source database.*sidecar/);
    await assert.rejects(db.backup(`${aliasedSource}${suffix}`), /source database.*sidecar/);
    assert.equal(existsSync(`${source}${suffix}`), false);
  }

  const fileAlias = join(dir, "file-alias.sqlite");
  try {
    symlinkSync(source, fileAlias, "file");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.diagnostic("File-symlink source case unavailable without Windows symlink permission; directory-junction cases covered");
      assert.deepEqual(readFileSync(source), before);
      return;
    }
    throw error;
  }
  const throughFile = open(t, fileAlias, { readOnly: true });
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    await assert.rejects(throughFile.backup(`${source}${suffix}`), /source database.*sidecar/);
    assert.equal(existsSync(`${source}${suffix}`), false);
  }
  assert.equal(db.get("safe"), true);
  assert.deepEqual(readFileSync(source), before);
});

test("backup source protection survives chdir after opening a relative source path", (t) => {
  const dir = tempDir(t);
  const initial = join(dir, "initial");
  const later = join(dir, "later");
  mkdirSync(initial);
  mkdirSync(later);
  // Run in a child so this regression cannot change cwd for neighboring tests.
  const script = `
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    import { join } from "node:path";
    import { Depo } from ${JSON.stringify(new URL("../dist/esm/index.js", import.meta.url).href)};
    const [initial, later] = process.argv.slice(1);
    process.chdir(initial);
    const db = new Depo("relative.sqlite");
    try {
      db.set("safe", true);
      process.chdir(later);
      assert.equal(db.path, "relative.sqlite");
      const sourceSidecar = join(initial, "relative.sqlite-journal");
      assert.equal(existsSync(sourceSidecar), false);
      await assert.rejects(db.backup(sourceSidecar), /source database.*sidecar/);
      assert.equal(existsSync(sourceSidecar), false);
      await db.backup("copy.sqlite");
      const copy = new Depo(join(later, "copy.sqlite"), { readOnly: true });
      try { assert.equal(copy.get("safe"), true); }
      finally { copy.close(); }
    } finally { db.close(); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, initial, later], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(initial, "relative.sqlite-journal")), false);
  assert.equal(existsSync(join(later, "copy.sqlite")), true);
});

test("backup supports in-memory and unnamed temporary sources without a source filename", async (t) => {
  const dir = tempDir(t);
  for (const [index, source] of [":memory:", ""].entries()) {
    const db = open(t, source);
    db.set("value", index);
    const target = join(dir, `temporary-${index}.sqlite`);
    await db.backup(target);
    const copy = open(t, target, { readOnly: true });
    assert.equal(copy.get("value"), index);
  }
});

test("backup rejects invalid targets and missing parents with useful causes without creating directories", async (t) => {
  const dir = tempDir(t);
  const db = open(t, ":memory:");
  for (const target of [undefined, null, 1, {}, "", "  ", ":memory:", "bad\0path", "bad\uD800"]) {
    await assert.rejects(db.backup(target), DepoError);
  }
  const missingParent = join(dir, "missing", "backup.sqlite");
  await assert.rejects(db.backup(missingParent), (error) => {
    assert.ok(error instanceof DepoError);
    assert.match(error.message, /existing parent directory/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  assert.equal(existsSync(join(dir, "missing")), false);
  await db.backup(join(dir, "valid.sqlite"));
  db.close();
  assert.equal(db.closed, true);
});

test("SQLite backup failure removes only the newly reserved target and releases the source lifetime guard", async (t) => {
  const dir = tempDir(t);
  const db = open(t, ":memory:");
  db.set("data", "x".repeat(16_384));
  const target = join(dir, "failed.sqlite");
  // SQLite must create a rollback journal to write the reserved destination.
  // A directory at its journal path forces a real SQLite I/O failure on Windows and POSIX.
  const journal = `${target}-journal`;
  mkdirSync(journal);
  writeFileSync(join(journal, "keep"), "preexisting");
  await assert.rejects(db.backup(target), (error) => {
    assert.ok(error instanceof DepoError);
    assert.match(error.message, /Backup .* failed/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  assert.equal(existsSync(target), false, "failed reserved file is removed");
  assert.equal(readFileSync(join(journal, "keep"), "utf8"), "preexisting");
  assert.equal(lstatSync(journal).isDirectory(), true);
  assert.equal(db.get("data").length, 16_384);
  await db.backup(join(dir, "retry.sqlite"));
  db.close();
  assert.equal(db.closed, true);
});

test("backup rejects transactions, guards close on every shared view, and permits close after settlement", async (t) => {
  const dir = tempDir(t);
  const db = open(t, join(dir, "source.sqlite"));
  const view = db.table("other");
  let rejected;
  const inTransaction = join(dir, "transaction.sqlite");
  db.transaction(() => {
    rejected = view.backup(inTransaction);
    db.set("committed", true);
  });
  await assert.rejects(rejected, /inside a transaction/);
  assert.equal(existsSync(inTransaction), false);
  const first = db.backup(join(dir, "first.sqlite"));
  const second = view.backup(join(dir, "second.sqlite"));
  assert.throws(() => db.close(), { name: "DepoError", message: /await backup/ });
  assert.throws(() => view.close(), { name: "DepoError", message: /await backup/ });
  assert.equal(db.closed, false);
  await Promise.all([first, second]);
  assert.equal(db.get("committed"), true);
  view.close();
  assert.equal(db.closed, true);
  await assert.rejects(view.backup(join(dir, "closed.sqlite")), /closed/);
  assert.equal(existsSync(join(dir, "closed.sqlite")), false);
});

test("read-only API and CLI backups preserve old schema and source bytes without upgrades or TTL cleanup", async (t) => {
  const dir = tempDir(t);
  const source = join(dir, "old.sqlite");
  const raw = new DatabaseSync(source);
  raw.exec(`
    CREATE TABLE depo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO depo_meta VALUES ('schema_version', '1');
    CREATE TABLE depo_entries (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (ns, key)) WITHOUT ROWID;
    INSERT INTO depo_entries VALUES ('default', 'expired', '42', 1);
    INSERT INTO depo_entries VALUES ('default', 'live', '99', NULL);
  `);
  raw.close();
  const before = readFileSync(source);
  const db = open(t, source, { readOnly: true });
  const target = join(dir, "copy.sqlite");
  await db.backup(target);
  db.close();
  assert.deepEqual(readFileSync(source), before);
  const inspection = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(inspection.prepare("SELECT count(*) AS n FROM depo_entries").get().n, 2);
    assert.equal(inspection.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('depo_scores', 'depo_limits')").get().n, 0);
  } finally { inspection.close(); }
  const copy = open(t, target, { readOnly: true });
  assert.equal(copy.get("live"), 99);
  assert.equal(copy.get("expired"), undefined);
  const cliTarget = join(dir, "cli-copy.sqlite");
  const result = cli("backup", source, "--to", cliTarget);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(source), before);
  const cliInspection = new DatabaseSync(cliTarget, { readOnly: true });
  try {
    assert.equal(cliInspection.prepare("SELECT count(*) AS n FROM depo_entries").get().n, 2);
    assert.equal(cliInspection.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('depo_scores', 'depo_limits')").get().n, 0);
  } finally { cliInspection.close(); }
});

test("CLI backup reads active WAL, preserves source and refuses overwrite", (t) => {
  const dir = tempDir(t);
  const db = open(t, join(dir, "source.sqlite"));
  db.set("root", true);
  db.table("guild").set("wal", { ok: true });
  db.table("guild").leaderboard("xp").set("winner", 50);
  const before = readFileSync(db.path);
  const walBefore = readFileSync(`${db.path}-wal`);
  const target = join(dir, "copy.sqlite");
  const result = cli("backup", db.path, "--to", target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Backed up/);
  assert.deepEqual(readFileSync(db.path), before);
  assert.deepEqual(readFileSync(`${db.path}-wal`), walBefore);
  const copy = open(t, target, { readOnly: true });
  assert.equal(copy.get("root"), true);
  assert.deepEqual(copy.table("guild").get("wal"), { ok: true });
  assert.equal(copy.table("guild").leaderboard("xp").score("winner"), 50);
  const targetBefore = readFileSync(target);
  const duplicate = cli("backup", db.path, "--to", target);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already exists/);
  assert.deepEqual(readFileSync(target), targetBefore);
});

test("CLI backup errors do not create a missing source or target and reject migration-only flags", (t) => {
  const dir = tempDir(t);
  const source = join(dir, "missing.sqlite");
  const target = join(dir, "copy.sqlite");
  const missing = cli("backup", source, "--to", target);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /source.*read-only.*source file exists/);
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(target), false);
  for (const args of [
    ["backup"],
    ["backup", source],
    ["backup", source, "extra", "--to", target],
    ["backup", source, "--to", target, "--unknown"],
    ["backup", ":memory:", "--to", target],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /Missing <source>|requires --to|Unexpected|Unknown option|existing SQLite file/);
  }
  for (const flags of [["--from", "wio"], ["--namespace", "other"], ["--table", "json"], ["--overwrite"], ["--dry-run"], ["--json"]]) {
    const result = cli("backup", source, "--to", target, ...flags);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /only supported by migrate/);
  }
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(target), false);
  const help = cli("backup", "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: depo migrate/);
  assert.match(help.stdout, /depo backup <source> --to <target>/);
  assert.match(help.stdout, /--dry-run/);
  const version = cli("--version");
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);
});
