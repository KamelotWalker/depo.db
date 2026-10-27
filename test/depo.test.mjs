import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { Depo, DepoError, escapeKey } from "../dist/esm/index.js";
import { onCleanup, sleep, tempDir } from "./helpers.mjs";

function open(t, options) {
  const db = new Depo(join(tempDir(t), "db.sqlite"), options);
  onCleanup(t, () => db.close());
  return db;
}

test("set/get round-trips JSON values", (t) => {
  const db = open(t);
  const values = {
    number: 42,
    float: 3.25,
    negative: -7,
    string: "merhaba dünya 🎉",
    empty: "",
    bool: false,
    nil: null,
    array: [1, "two", { three: [3] }],
    object: { a: { b: { c: true } } },
  };
  for (const [key, value] of Object.entries(values)) assert.deepEqual(db.set(key, value), value);
  for (const [key, value] of Object.entries(values)) assert.deepEqual(db.get(key), value);
  assert.equal(db.get("missing"), undefined);
  assert.equal(db.get("missing", "fallback"), "fallback");
  assert.equal(db.get("nil", "fallback"), null, "a stored null is a value, not a miss");
});

test("get returns a fresh copy; mutating it does not change the store", (t) => {
  const db = open(t);
  db.set("obj", { list: [1] });
  db.get("obj").list.push(2);
  assert.deepEqual(db.get("obj"), { list: [1] });
});

test("has / delete / count / deleteAll", (t) => {
  const db = open(t);
  db.set("a", 1);
  db.set("b", null);
  assert.equal(db.has("a"), true);
  assert.equal(db.has("b"), true);
  assert.equal(db.has("c"), false);
  assert.equal(db.count(), 2);
  assert.equal(db.delete("a"), true);
  assert.equal(db.delete("a"), false);
  assert.equal(db.has("a"), false);
  db.set("x", 1);
  assert.equal(db.deleteAll(), 2);
  assert.equal(db.count(), 0);
});

test("all() orders by key and supports prefix and limit", (t) => {
  const db = open(t);
  for (const key of ["user_2", "guild_1", "user_10", "user_1", "users"]) db.set(key, key.length);
  assert.deepEqual(
    db.all().map((e) => e.key),
    ["guild_1", "user_1", "user_10", "user_2", "users"],
  );
  assert.deepEqual(
    db.all({ prefix: "user_" }).map((e) => e.key),
    ["user_1", "user_10", "user_2"],
  );
  assert.deepEqual(db.all({ prefix: "user_", limit: 2 }), [
    { key: "user_1", value: 6 },
    { key: "user_10", value: 7 },
  ]);
  assert.deepEqual(db.all({ prefix: "nope" }), []);
  assert.throws(() => db.all({ limit: -1 }), DepoError);
});

test("dot paths read and write inside values", (t) => {
  const db = open(t);
  db.set("user.42.name", "Ayşe");
  db.set("user.42.stats.level", 3);
  assert.deepEqual(db.get("user"), { 42: { name: "Ayşe", stats: { level: 3 } } });
  assert.equal(db.get("user.42.stats.level"), 3);
  assert.equal(db.get("user.43.name"), undefined);
  assert.equal(db.has("user.42.name"), true);
  assert.equal(db.delete("user.42.stats"), true);
  assert.equal(db.delete("user.42.stats"), false);
  assert.deepEqual(db.get("user"), { 42: { name: "Ayşe" } });
});

test("numeric path segments never create arrays but do index existing ones", (t) => {
  const db = open(t);
  db.set("slots.2", "x");
  assert.deepEqual(db.get("slots"), { 2: "x" });
  db.set("list", ["a", "b", "c"]);
  assert.equal(db.get("list.1"), "b");
  db.set("list.1", "B");
  db.set("list.3", "d");
  assert.deepEqual(db.get("list"), ["a", "B", "c", "d"]);
  assert.throws(() => db.set("list.9", "z"), /holes are not allowed/);
  assert.throws(() => db.set("list.name", "z"), /not an array index/);
  assert.equal(db.delete("list.0"), true);
  assert.deepEqual(db.get("list"), ["B", "c", "d"], "deleting an index splices");
});

test("writing through a primitive throws instead of overwriting", (t) => {
  const db = open(t);
  db.set("n", 5);
  assert.throws(() => db.set("n.x", 1), /its value is number/);
  db.set("o", { s: "text" });
  assert.throws(() => db.set("o.s.x", 1), /o\.s: its value is string/);
  assert.equal(db.get("n"), 5);
  assert.deepEqual(db.get("o"), { s: "text" });
});

test("escaped dots and array keys address literal keys", (t) => {
  const db = open(t);
  db.set("site\\.com.visits", 1);
  assert.deepEqual(db.all(), [{ key: "site.com", value: { visits: 1 } }]);
  assert.equal(db.get(["site.com", "visits"]), 1);
  assert.equal(db.get(`${escapeKey("site.com")}.visits`), 1);
  db.set(["a\\b", "c.d"], true);
  assert.deepEqual(db.get("a\\\\b"), { "c.d": true });
  assert.equal(escapeKey("a\\b.c"), "a\\\\b\\.c");
});

test("invalid keys are rejected", (t) => {
  const db = open(t);
  for (const key of ["", ".a", "a.", "a..b", "a\\x", "trailing\\", [], [""], ["a", ""]]) {
    assert.throws(() => db.get(key), DepoError, `key ${JSON.stringify(key)}`);
  }
  assert.throws(() => db.get(5), DepoError);
});

test("keys and namespaces with lone UTF-16 surrogates are rejected instead of colliding", (t) => {
  const db = open(t);
  // SQLite stores TEXT as UTF-8 and would turn both into "…\uFFFD", addressing the same row.
  const first = "tenant_\ud800";
  const second = "tenant_\ud801";
  assert.throws(() => db.table(first), /lone UTF-16 surrogate/);
  assert.throws(() => new Depo(db.path, { namespace: second }), /lone UTF-16 surrogate/);
  for (const key of ["key_\ud800", ["key_\udc00", "path"], "key_\ud801.path"]) {
    assert.throws(() => db.set(key, 1), /lone UTF-16 surrogate/, `set ${JSON.stringify(key)}`);
    assert.throws(() => db.get(key), /lone UTF-16 surrogate/, `get ${JSON.stringify(key)}`);
    assert.throws(() => db.add(key, 1), /lone UTF-16 surrogate/);
    assert.throws(() => db.push(key, 1), /lone UTF-16 surrogate/);
    assert.throws(() => db.delete(key), /lone UTF-16 surrogate/);
  }
  assert.throws(() => db.expire("key_\ud800", 1000), /lone UTF-16 surrogate/);
  assert.throws(() => db.all({ prefix: "key_\ud800" }), /lone UTF-16 surrogate/);
  assert.equal(db.count(), 0);
  // Well-formed text (surrogate pairs included) is unaffected, and so are path segments, which live in JSON.
  db.set("emoji_😀", 1);
  db.set(["obj", "\ud800"], 1);
  db.set(["obj", "\ud801"], 2);
  assert.equal(db.get("emoji_😀"), 1);
  assert.deepEqual(db.get("obj"), { "\ud800": 1, "\ud801": 2 });
});

test("__proto__ and inherited names are plain data", (t) => {
  const db = open(t);
  db.set("obj.__proto__.polluted", true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(db.get("obj")), ["__proto__"]);
  assert.equal(db.get("obj.__proto__.polluted"), true);
  db.set("plain", {});
  assert.equal(db.get("plain.toString"), undefined);
  assert.equal(db.get("plain.constructor"), undefined);
  db.set("__proto__", 1);
  assert.equal(db.get("__proto__"), 1);
});

test("unsupported values are rejected before writing", (t) => {
  const db = open(t);
  assert.throws(() => db.set("u", undefined), /use delete/);
  assert.throws(() => db.set("f", () => 1), /not JSON-serializable/);
  assert.throws(() => db.set("b", 10n), /not JSON-serializable/);
  assert.throws(() => db.push("l", undefined), /undefined/);
  assert.equal(db.count(), 0);
  // Path writes and push embed the value in an entry, where JSON.stringify would drop a function or turn a symbol into null.
  db.set("obj", { balance: 100 });
  db.set("arr", [1]);
  assert.throws(() => db.set("obj.balance", () => 1), /Cannot store a function at obj\.balance/);
  assert.throws(() => db.set(["obj", "s"], Symbol("x")), /Cannot store a symbol/);
  assert.throws(() => db.push("arr", Symbol("x")), /Cannot store a symbol at arr/);
  assert.throws(() => db.push("arr", 2, () => 1), /Cannot store a function/);
  assert.throws(() => db.set("s", Symbol("x")), /not JSON-serializable/);
  assert.deepEqual(db.get("obj"), { balance: 100 });
  assert.deepEqual(db.get("arr"), [1]);
  // JSON semantics: Dates become strings.
  db.set("d", new Date(0));
  assert.equal(db.get("d"), "1970-01-01T00:00:00.000Z");
});

test("add / subtract", (t) => {
  const db = open(t);
  assert.equal(db.add("coins", 5), 5);
  assert.equal(db.add("coins", 2.5), 7.5);
  assert.equal(db.subtract("coins", 10), -2.5);
  assert.equal(db.add("user.1.xp", 10), 10);
  assert.deepEqual(db.get("user"), { 1: { xp: 10 } });
  db.set("name", "x");
  assert.throws(() => db.add("name", 1), /not a number/);
  assert.throws(() => db.add("coins", Number.NaN), /finite/);
  assert.throws(() => db.add("coins", "1"), /finite/);
  db.set("big", Number.MAX_VALUE);
  assert.throws(() => db.add("big", Number.MAX_VALUE), /not a finite number/);
  assert.equal(db.get("big"), Number.MAX_VALUE);
});

test("push / pull", (t) => {
  const db = open(t);
  assert.deepEqual(db.push("items", "sword"), ["sword"]);
  assert.deepEqual(db.push("items", "shield", { id: 1 }, "sword"), ["sword", "shield", { id: 1 }, "sword"]);
  assert.deepEqual(db.pull("items", "sword"), ["shield", { id: 1 }], "removes every equal element");
  assert.deepEqual(db.pull("items", { id: 1 }), ["shield"], "deep equality");
  db.push("nums", 1, 2, 3, 4);
  assert.deepEqual(db.pull("nums", (n) => n % 2 === 0), [1, 3]);
  assert.deepEqual(db.pull("nums", (_n, index) => index === 0), [3]);
  assert.deepEqual(db.pull("missing", 1), []);
  assert.equal(db.has("missing"), false, "pull on a missing key writes nothing");
  db.push("guild.1.roles", "admin");
  assert.deepEqual(db.get("guild"), { 1: { roles: ["admin"] } });
  db.set("str", "x");
  assert.throws(() => db.push("str", 1), /not an array/);
  assert.throws(() => db.pull("str", 1), /not an array/);
});

test("TTL: entries expire, ttl() and expire() report and change it", async (t) => {
  const db = open(t);
  db.set("short", 1, { ttl: 40 });
  db.set("long", 2, { ttl: 60_000 });
  db.set("forever", 3);
  const remaining = db.ttl("long");
  assert.ok(remaining > 59_000 && remaining <= 60_000, `remaining ${remaining}`);
  assert.equal(db.ttl("forever"), null);
  assert.equal(db.ttl("missing"), undefined);
  assert.equal(db.get("short"), 1);
  await sleep(80);
  assert.equal(db.get("short"), undefined);
  assert.equal(db.has("short"), false);
  assert.equal(db.count(), 2);
  assert.deepEqual(db.all().map((e) => e.key), ["forever", "long"]);
  assert.equal(db.delete("short"), false, "expired entries are already gone");
  assert.equal(db.add("short", 1), 1, "an expired entry counts as missing");
  assert.equal(db.ttl("short"), null, "re-created without TTL");

  assert.equal(db.expire("forever", 30), true);
  assert.equal(db.expire("missing", 30), false);
  assert.equal(db.expire("long", null), true);
  assert.equal(db.ttl("long"), null);
  await sleep(60);
  assert.equal(db.get("forever"), undefined);
});

test("TTL: path writes keep the TTL, whole-entry set replaces it", (t) => {
  const db = open(t);
  db.set("session", { a: 1 }, { ttl: 60_000 });
  db.set("session.b", 2);
  db.add("session.a", 1);
  assert.ok(db.ttl("session") > 0);
  db.set("session", { reset: true });
  assert.equal(db.ttl("session"), null);
  assert.throws(() => db.set("session.x", 1, { ttl: 10 }), /whole entries/);
  assert.throws(() => db.ttl("session.reset"), /whole entries/);
  for (const ttl of [0, -1, Number.NaN, Infinity, "10"]) {
    assert.throws(() => db.set("k", 1, { ttl }), /ttl must be/);
  }
});

test("purgeExpired removes expired rows from disk", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "db.sqlite");
  const db = new Depo(file);
  db.set("a", 1, { ttl: 10 });
  db.set("b", 1, { ttl: 10 });
  db.set("c", 1);
  await sleep(30);
  assert.equal(db.purgeExpired(), 2);
  db.close();
  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM depo_entries").get().n, 1);
  raw.close();
});

test("namespaces isolate keys and share one connection", (t) => {
  const db = open(t);
  const economy = db.table("economy");
  db.set("x", "default");
  economy.set("x", "economy");
  assert.equal(db.get("x"), "default");
  assert.equal(economy.get("x"), "economy");
  assert.equal(economy.namespace, "economy");
  assert.equal(economy.deleteAll(), 1);
  assert.equal(db.get("x"), "default");
  const sameFile = new Depo(db.path, { namespace: "economy" });
  economy.set("y", 1);
  assert.equal(sameFile.get("y"), 1);
  sameFile.close();
  assert.throws(() => db.table(""), DepoError);
});

test("transaction commits atomically, rolls back on error, nests with savepoints", (t) => {
  const db = open(t);
  const bank = db.table("bank");
  bank.set("alice", 100);
  bank.set("bob", 0);
  db.transaction(() => {
    bank.subtract("alice", 30);
    bank.add("bob", 30);
  });
  assert.deepEqual([bank.get("alice"), bank.get("bob")], [70, 30]);

  assert.throws(
    () =>
      db.transaction(() => {
        bank.subtract("alice", 70);
        throw new Error("abort");
      }),
    /abort/,
  );
  assert.equal(bank.get("alice"), 70);

  const result = db.transaction(() => {
    bank.add("bob", 1);
    try {
      db.transaction(() => {
        bank.add("bob", 1000);
        throw new Error("inner");
      });
    } catch {
      // inner rolled back only
    }
    return bank.get("bob");
  });
  assert.equal(result, 31);
  assert.equal(bank.get("bob"), 31);
});

test("transaction rejects async callbacks and rolls back", async (t) => {
  const db = open(t);
  assert.throws(
    () =>
      db.transaction(async () => {
        db.set("a", 1);
      }),
    /must be synchronous/,
  );
  assert.equal(db.has("a"), false);
});

test("async transaction callbacks never start or resume after rejection", async (t) => {
  const db = open(t);
  let invoked = false;
  const callback = async () => {
    invoked = true;
    db.set("before", 1);
    await Promise.resolve();
    db.set("after", 2);
  };
  assert.throws(() => db.transaction(callback), /remove async\/await/);
  await Promise.resolve();
  assert.equal(invoked, false);
  assert.equal(db.has("before"), false);
  assert.equal(db.has("after"), false);

  db.transaction(() => {
    db.set("outer", 1);
    assert.throws(() => db.transaction(callback), /must be synchronous/);
    db.set("outer", 2);
  });
  await Promise.resolve();
  assert.equal(invoked, false);
  assert.equal(db.get("outer"), 2);
});

test("data persists across reopen; closed instances throw", (t) => {
  const file = join(tempDir(t), "db.sqlite");
  const first = new Depo(file);
  first.set("k", { v: 1 });
  first.table("other").set("k", 2);
  first.close();
  assert.equal(first.closed, true);
  assert.throws(() => first.get("k"), /closed/);
  first.close();
  const second = new Depo(file);
  assert.deepEqual(second.get("k"), { v: 1 });
  assert.equal(second.table("other").get("k"), 2);
  second.close();
});

test("connection uses WAL, busy timeout and the chosen synchronous level", (t) => {
  const dir = tempDir(t);
  const full = new Depo(join(dir, "full.sqlite"));
  full.close();
  const raw = new DatabaseSync(join(dir, "full.sqlite"));
  assert.equal(raw.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  raw.close();
  assert.throws(() => new Depo(join(dir, "x.sqlite"), { synchronous: "off" }), /synchronous/);
  assert.throws(() => new Depo(join(dir, "x.sqlite"), { busyTimeout: -1 }), /busyTimeout/);
  const memory = new Depo(":memory:", { synchronous: "normal" });
  memory.set("a", 1);
  assert.equal(memory.get("a"), 1);
  memory.close();
});

test("refuses files written by a newer schema version", (t) => {
  const file = join(tempDir(t), "db.sqlite");
  new Depo(file).close();
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE depo_meta SET value = '99' WHERE key = 'schema_version'").run();
  raw.close();
  assert.throws(() => new Depo(file), /schema version 99/);
});
