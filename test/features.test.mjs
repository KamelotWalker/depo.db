import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Depo, DepoError, Leaderboard } from "../dist/esm/index.js";
import { onCleanup, tempDir } from "./helpers.mjs";

function open(t, options) {
  const db = new Depo(join(tempDir(t), "db.sqlite"), options);
  onCleanup(t, () => db.close());
  return db;
}

test("leaderboards order scores and BINARY ties; rank agrees with paginated top", (t) => {
  const db = open(t);
  const board = db.leaderboard("xp.guild.1");
  assert.ok(board instanceof Leaderboard);
  assert.equal(board.score("missing"), undefined);
  assert.equal(board.rank("missing"), undefined);
  assert.equal(board.count(), 0);
  assert.deepEqual(board.top(), []);
  const members = ["z", "A", "a", "é", "\uE000", "😀"];
  db.transaction(() => {
    for (const member of members) assert.equal(board.set(member, 10), 10);
    assert.equal(board.add("winner", 20.5), 20.5);
    assert.equal(board.add("last", -2), -2);
  });
  const expected = ["winner", ...members, "last"];
  // BINARY compares UTF-8, not JavaScript's UTF-16 code units (U+E000 precedes emoji).
  expected.splice(1, members.length, "A", "a", "z", "é", "\uE000", "😀");
  assert.deepEqual(board.top().map((entry) => entry.member), expected);
  for (const entry of board.top()) assert.equal(board.rank(entry.member), entry.rank);
  assert.deepEqual(board.top(3, 2), board.top().slice(2, 5));
  assert.deepEqual(board.top(0), []);
  assert.deepEqual(board.top(10, 100), []);
  assert.equal(board.top(Number.MAX_VALUE).length, 8);
  assert.deepEqual(board.top(10, Number.MAX_VALUE), []);
  assert.equal(board.add("last", 12), 10);
  assert.equal(board.rank("last"), 4);
  assert.equal(board.set("winner", -10), -10);
  assert.equal(board.rank("winner"), 8);
  assert.equal(board.remove("missing"), false);
  assert.equal(board.remove("winner"), true);
  assert.equal(board.remove("winner"), false);
  assert.equal(board.clear(), 7);
  assert.equal(board.clear(), 0);
});

test("leaderboards isolate boards and namespaces, survive deleteAll and share connection lifetime", (t) => {
  const db = open(t);
  const board = db.leaderboard("xp");
  const other = db.table("guild.2").leaderboard("xp");
  board.set("user.1", 100);
  db.leaderboard("coins").set("user.1", 5);
  other.set("user.1", 200);
  db.set("entry", true);
  assert.equal(db.deleteAll(), 1);
  assert.equal(board.score("user.1"), 100);
  assert.equal(db.leaderboard("xp").score("user.1"), 100);
  assert.equal(db.leaderboard("coins").score("user.1"), 5);
  assert.equal(other.score("user.1"), 200);
  assert.equal(board.clear(), 1);
  assert.equal(other.count(), 1);
  db.close();
  for (const action of [() => board.score("x"), () => board.top(), () => other.add("x", 1)]) {
    assert.throws(action, /closed/);
  }
});

test("leaderboards reject invalid names, members, scores and pagination without changing scores", (t) => {
  const db = open(t);
  const board = db.leaderboard("xp");
  for (const name of ["", "bad\uD800", null, 1, [], {}]) {
    assert.throws(() => db.leaderboard(name), DepoError);
    for (const action of [() => board.set(name, 1), () => board.add(name, 1), () => board.score(name), () => board.rank(name), () => board.remove(name)]) {
      assert.throws(action, DepoError);
    }
  }
  for (const score of [NaN, Infinity, -Infinity, "1", null, undefined]) {
    assert.throws(() => board.set("user", score), DepoError);
    assert.throws(() => board.add("user", score), DepoError);
  }
  for (const value of [-1, 0.5, NaN, Infinity, "1", null]) {
    assert.throws(() => board.top(value), DepoError);
    assert.throws(() => board.top(10, value), DepoError);
  }
  board.set("max", Number.MAX_VALUE);
  board.set("min", -Number.MAX_VALUE);
  assert.throws(() => board.add("max", Number.MAX_VALUE), DepoError);
  assert.throws(() => board.add("min", -Number.MAX_VALUE), DepoError);
  assert.equal(board.score("max"), Number.MAX_VALUE);
  assert.equal(board.score("min"), -Number.MAX_VALUE);
  assert.equal(board.count(), 2);
});

test("GCRA allows a burst, smoothly refills and denied calls do not consume capacity", (t) => {
  const db = open(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const options = { limit: 3, window: 12_000 };
  assert.deepEqual(db.rateLimit("command.user.1", options), { allowed: true, remaining: 2, retryAfter: 0, resetAfter: 4000 });
  assert.deepEqual(db.rateLimit("command.user.1", options), { allowed: true, remaining: 1, retryAfter: 0, resetAfter: 8000 });
  assert.deepEqual(db.rateLimit("command.user.1", options), { allowed: true, remaining: 0, retryAfter: 0, resetAfter: 12000 });
  assert.deepEqual(db.rateLimit("command.user.1", options), { allowed: false, remaining: 0, retryAfter: 4000, resetAfter: 12000 });
  now += 2000;
  for (let i = 0; i < 3; i++) assert.deepEqual(db.rateLimit("command.user.1", options), { allowed: false, remaining: 0, retryAfter: 2000, resetAfter: 10000 });
  now += 2000;
  assert.deepEqual(db.rateLimit("command.user.1", options), { allowed: true, remaining: 0, retryAfter: 0, resetAfter: 12000 });
  now += 30_000;
  assert.equal(db.rateLimit("command.user.1", options).remaining, 2);
});

test("GCRA handles fractional intervals, single-use limits, reset and namespace isolation", (t) => {
  const db = open(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const options = { limit: 3, window: 10_000 };
  for (let remaining = 2; remaining >= 0; remaining--) {
    const result = db.rateLimit("fractional", options);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, remaining);
  }
  const denied = db.rateLimit("fractional", options);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 3334);
  now += 3334;
  assert.equal(db.rateLimit("fractional", options).allowed, true);
  const single = { limit: 1, window: 2.5 };
  assert.deepEqual(db.rateLimit("literal.key", single), { allowed: true, remaining: 0, retryAfter: 0, resetAfter: 3 });
  assert.equal(db.rateLimit("literal.key", single).allowed, false);
  assert.equal(db.table("other").rateLimit("literal.key", single).allowed, true);
  db.set("entry", 1);
  db.deleteAll();
  assert.equal(db.rateLimit("literal.key", single).allowed, false);
  assert.equal(db.resetRateLimit("literal.key"), true);
  assert.equal(db.resetRateLimit("literal.key"), false);
  assert.equal(db.rateLimit("literal.key", single).allowed, true);
  now += 3;
  assert.equal(db.rateLimit("literal.key", single).allowed, true);
});

test("GCRA durations match exact integer-millisecond arithmetic through refill and clock steps", (t) => {
  const db = open(t);
  let now = 1_800_000_000_000;
  let seed = 42;
  t.mock.method(Date, "now", () => now);
  db.transaction(() => {
    for (const [limit, window] of [[3, 1000], [7, 1000], [50, 7], [777, 1_000_000_000], [1000, 1], [2, 500], [11, 60_000], [10, 10_000], [3, 12_000], [17, 997]]) {
      now = 1_800_000_000_000;
      const scale = BigInt(limit);
      const span = BigInt(window);
      let tat = BigInt(now) * scale;
      for (let i = 0; i < 1200; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        now += i === 0 ? 0 : i % 97 === 0 ? -50 : seed % 31;
        const current = BigInt(now) * scale;
        const base = tat > current ? tat : current;
        const allowed = base - current <= span * (scale - 1n);
        if (allowed) tat = base + span;
        const debt = tat - current;
        const expected = {
          allowed,
          remaining: allowed ? Number((span * scale - debt) / span) : 0,
          retryAfter: allowed ? 0 : Number((debt - span * (scale - 1n) + scale - 1n) / scale),
          resetAfter: Number((debt + scale - 1n) / scale),
        };
        assert.deepEqual(db.rateLimit(`model:${limit}:${window}`, { limit, window }), expected, `${limit}/${window}, call ${i}`);
      }
    }
    for (const window of [1 + 1e-9, 1_000_000_000 + 1e-6]) {
      const options = { limit: 1, window };
      const key = `genuinely-fractional:${window}`;
      assert.equal(db.rateLimit(key, options).resetAfter, Math.ceil(window));
      assert.equal(db.rateLimit(key, options).retryAfter, Math.ceil(window));
    }
  });
});

test("rate limits reject invalid keys and options with DepoError", (t) => {
  const db = open(t);
  const valid = { limit: 3, window: 10_000 };
  for (const key of ["", "bad\uDC00", [], ["key"], 3, null]) {
    assert.throws(() => db.rateLimit(key, valid), DepoError);
    assert.throws(() => db.resetRateLimit(key), DepoError);
  }
  for (const limit of [0, -1, 0.5, NaN, Infinity, "3", null, undefined]) {
    assert.throws(() => db.rateLimit("key", { ...valid, limit }), DepoError);
  }
  for (const window of [0, -1, NaN, Infinity, "100", null, undefined]) {
    assert.throws(() => db.rateLimit("key", { ...valid, window }), DepoError);
  }
  for (const options of [undefined, null, {}]) assert.throws(() => db.rateLimit("key", options), DepoError);
  assert.equal(db.resetRateLimit("key"), false);
});

test("GCRA preserves burst capacity for sub-millisecond intervals and finite extreme windows", (t) => {
  const db = open(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  db.transaction(() => {
    for (const [key, options] of [
      ["fast", { limit: 1000, window: 1 }],
      ["tiny", { limit: 3, window: Number.MIN_VALUE }],
      ["huge", { limit: 3, window: Number.MAX_VALUE }],
    ]) {
      for (let i = 0; i < options.limit; i++) {
        const result = db.rateLimit(key, options);
        assert.equal(result.allowed, true, `${key}: use ${i + 1}`);
        assert.equal(result.remaining, options.limit - i - 1);
        assert.ok(Number.isFinite(result.resetAfter));
      }
      const denied = db.rateLimit(key, options);
      assert.equal(denied.allowed, false, key);
      assert.ok(denied.retryAfter > 0 && Number.isFinite(denied.retryAfter));
    }
    assert.equal(db.purgeExpired(), 0);
    now++;
    assert.equal(db.purgeExpired(), 2);
  });
});

test("purgeExpired counts expired entries and fully refilled limits in every namespace", (t) => {
  const db = open(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  db.set("expired", 1, { ttl: 10 });
  db.set("live", 2);
  db.leaderboard("xp").set("user", 1);
  db.rateLimit("ready", { limit: 1, window: 10 });
  db.table("other").rateLimit("also-ready", { limit: 1, window: 10 });
  db.rateLimit("not-ready", { limit: 1, window: 100 });
  assert.equal(db.purgeExpired(), 0);
  now += 10;
  assert.equal(db.purgeExpired(), 3);
  assert.equal(db.purgeExpired(), 0);
  assert.equal(db.resetRateLimit("ready"), false);
  assert.equal(db.resetRateLimit("not-ready"), true);
  assert.equal(db.leaderboard("xp").count(), 1);
  assert.equal(db.get("live"), 2);
});

test("leaderboards and rate limits participate in outer transactions and nested savepoints", (t) => {
  const db = open(t);
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const board = db.table("guild").leaderboard("xp");
  const options = { limit: 1, window: 10_000 };
  assert.throws(() => db.transaction(() => {
    board.add("user", 10);
    db.rateLimit("command", options);
    throw new Error("abort");
  }), /abort/);
  assert.equal(board.score("user"), undefined);
  assert.equal(db.resetRateLimit("command"), false);
  db.transaction(() => {
    board.set("user", 5);
    db.rateLimit("command", options);
    assert.throws(() => db.transaction(() => {
      board.clear();
      db.resetRateLimit("command");
      throw new Error("inner");
    }), /inner/);
    assert.equal(board.score("user"), 5);
    assert.equal(db.rateLimit("command", options).allowed, false);
  });
  const peer = new Depo(db.path);
  onCleanup(t, () => peer.close());
  assert.equal(peer.table("guild").leaderboard("xp").score("user"), 5);
  assert.equal(peer.rateLimit("command", options).allowed, false);
});

function createOldFile(file) {
  const raw = new DatabaseSync(file);
  raw.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE depo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO depo_meta VALUES ('schema_version', '1');
    CREATE TABLE depo_entries (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (ns, key)) WITHOUT ROWID;
    CREATE INDEX depo_entries_expires_at ON depo_entries (expires_at) WHERE expires_at IS NOT NULL;
    INSERT INTO depo_entries VALUES ('default', 'old', '42', NULL);
  `);
  raw.close();
}

test("0.1 files are readable without new tables; read-only opens do not create them", (t) => {
  const file = join(tempDir(t), "old.sqlite");
  createOldFile(file);
  const before = readFileSync(file);
  const db = new Depo(file, { readOnly: true });
  assert.equal(db.get("old"), 42);
  const board = db.leaderboard("xp");
  assert.deepEqual(board.top(), []);
  assert.equal(board.count(), 0);
  assert.equal(board.score("user"), undefined);
  assert.equal(board.rank("user"), undefined);
  assert.equal(db.purgeExpired(), 0);
  db.close();
  assert.deepEqual(readFileSync(file), before);
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('depo_scores', 'depo_limits')").get().n, 0);
  raw.close();
  const upgraded = new Depo(file);
  assert.equal(upgraded.get("old"), 42);
  upgraded.leaderboard("xp").add("user", 1);
  assert.equal(upgraded.rateLimit("key", { limit: 1, window: 10_000 }).allowed, true);
  upgraded.close();
  const oldReader = new DatabaseSync(file);
  assert.equal(oldReader.prepare("SELECT value FROM depo_meta WHERE key = 'schema_version'").get().value, "1");
  assert.equal(oldReader.prepare("SELECT value FROM depo_entries WHERE ns = 'default' AND key = 'old'").get().value, "42");
  assert.equal(oldReader.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('depo_scores', 'depo_limits')").get().n, 2);
  oldReader.close();
});

test("read-only feature views discover tables added by a later writable upgrade", (t) => {
  const file = join(tempDir(t), "rolling-upgrade.sqlite");
  createOldFile(file);
  const reader = new Depo(file, { readOnly: true });
  onCleanup(t, () => reader.close());
  const board = reader.leaderboard("xp");
  assert.deepEqual(board.top(), []);
  assert.equal(board.score("user"), undefined);
  assert.equal(reader.purgeExpired(), 0);
  const writer = new Depo(file);
  onCleanup(t, () => writer.close());
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  writer.leaderboard("xp").set("user", 5);
  writer.leaderboard("xp").set("leader", 10);
  writer.rateLimit("command", { limit: 1, window: 10 });
  assert.equal(board.score("user"), 5);
  assert.equal(board.rank("user"), 2);
  assert.equal(board.count(), 2);
  assert.deepEqual(board.top(), [
    { member: "leader", score: 10, rank: 1 },
    { member: "user", score: 5, rank: 2 },
  ]);
  now += 10;
  assert.throws(() => reader.purgeExpired(), /readonly|read-only/);
  assert.equal(writer.purgeExpired(), 1);
  assert.equal(reader.purgeExpired(), 0);
  writer.leaderboard("xp").add("user", 10);
  assert.equal(board.rank("user"), 1);
});

test("opening a complete file needs no write lock and read-only feature reads work", (t) => {
  const db = open(t);
  db.leaderboard("xp").set("user", 5);
  db.rateLimit("key", { limit: 1, window: 60_000 });
  const raw = new DatabaseSync(db.path);
  onCleanup(t, () => raw.close());
  raw.exec("BEGIN IMMEDIATE");
  try {
    const peer = new Depo(db.path, { busyTimeout: 0 });
    assert.equal(peer.leaderboard("xp").score("user"), 5);
    peer.close();
    const reader = new Depo(db.path, { readOnly: true });
    assert.deepEqual(reader.leaderboard("xp").top(), [{ member: "user", score: 5, rank: 1 }]);
    assert.throws(() => reader.leaderboard("xp").add("user", 1), /readonly|read-only/);
    reader.close();
  } finally {
    raw.exec("ROLLBACK");
  }
});

test("purging and writable opens spend only one busyTimeout waiting for the write lock", (t) => {
  const busyTimeout = 120;
  const db = open(t, { busyTimeout });
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  db.set("expired", 1, { ttl: 10 });
  db.rateLimit("refilled", { limit: 1, window: 10 });
  now += 10;
  const holder = new DatabaseSync(db.path);
  onCleanup(t, () => holder.close());
  holder.exec("BEGIN IMMEDIATE");
  try {
    for (const action of [() => db.purgeExpired(), () => new Depo(db.path, { busyTimeout })]) {
      const start = performance.now();
      assert.throws(action, /database is locked/);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < busyTimeout * 1.5, `waited ${elapsed.toFixed(1)} ms for a ${busyTimeout} ms timeout`);
    }
  } finally {
    holder.exec("ROLLBACK");
  }
  assert.equal(db.purgeExpired(), 2);
});
