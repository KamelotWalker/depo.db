import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryDriver, QuickDB, SqliteDriver } from "../dist/esm/compat/quickdb.js";
import { FIXTURES, onCleanup, tempDir } from "./helpers.mjs";

// The real quick.db 9.1.7 (+ better-sqlite3) is a devDependency used as the reference implementation.
const require = createRequire(import.meta.url);
const Real = require("quick.db");

/** Operations run against both implementations; every result or error message must match. */
const SCENARIO = [
  (db) => db.get("missing"),
  (db) => db.has("missing"),
  (db) => db.set("a", 1),
  (db) => db.get("a"),
  (db) => db.has("a"),
  (db) => db.set("obj", { x: 1 }),
  (db) => db.set("obj.y.z", 2),
  (db) => db.get("obj.y"),
  (db) => db.get("obj.nope.deeper"),
  (db) => db.get("missingrow.path"),
  (db) => db.set("fresh.0", "x"),
  (db) => db.get("fresh"),
  (db) => db.set("list", [1, 2, 3]),
  (db) => db.get("list.1"),
  (db) => db.get("list.length"),
  (db) => db.set("list.5", 6),
  (db) => db.get("list"),
  (db) => db.set("brack", {}),
  (db) => db.set("brack.items[0].name", "n"),
  (db) => db.get("brack"),
  (db) => db.get("brack.items[0].name"),
  (db) => db.set("prim", 5),
  (db) => db.set("prim.x", 1),
  (db) => db.get("prim"),
  (db) => db.set("n", null),
  (db) => db.set("u"),
  (db) => db.set(5, 1),
  (db) => db.get(5),
  (db) => db.set("unicode_ğüşİ", "değer 🎉"),
  (db) => db.get("unicode_ğüşİ"),
  (db) => db.add("c", 5),
  (db) => db.add("c", "2"),
  (db) => db.sub("c", 1.5),
  (db) => db.add("obj.y.z", 3),
  (db) => db.add("deep.counter", 1),
  (db) => db.get("deep"),
  (db) => db.set("s", "abc"),
  (db) => db.add("s", 1),
  (db) => db.get("s"),
  (db) => db.add("c"),
  (db) => db.push("p", 1, 2),
  (db) => db.push("p", [3]),
  (db) => db.push("p"),
  (db) => db.push("a", 1),
  (db) => db.push("nested.arr", "v"),
  (db) => db.get("nested"),
  (db) => db.unshift("p", 0),
  (db) => db.unshift("p", [-2, -1]),
  (db) => db.unshift("p"),
  (db) => db.pop("p"),
  (db) => db.shift("p"),
  (db) => db.get("p"),
  (db) => db.pop("emptyarr"),
  (db) => db.pull("p", 1),
  (db) => db.pull("p", [2, 0]),
  (db) => db.pull("p", (v) => v === -1),
  (db) => db.pull("p", (_v, index) => index === "0"),
  (db) => db.pull("p"),
  (db) => db.push("objs", { id: 1 }),
  (db) => db.pull("objs", { id: 1 }),
  (db) => db.startsWith("o"),
  (db) => db.startsWith(1),
  (db) => db.delete("obj.y"),
  (db) => db.get("obj"),
  (db) => db.delete("a"),
  (db) => db.delete("a"),
  (db) => db.delete("ghost.path"),
  (db) => db.get("ghost"),
  (db) => db.delete(1),
  (db) => db.all(),
  (db) => db.table("t2").set("k", 1),
  (db) => db.table("t2").all(),
  (db) => db.table("t2").get("k"),
  (db) => db.deleteAll(),
  (db) => db.all(),
];

async function outcome(fn) {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error: error.message };
  }
}

function closeReal(db) {
  db.driver.database.close();
}

test("behaves like quick.db 9.1.7 on a shared scenario", async (t) => {
  const dir = tempDir(t);
  const real = new Real.QuickDB({ filePath: join(dir, "real.sqlite") });
  const ours = new QuickDB({ filePath: join(dir, "ours.sqlite") });
  onCleanup(t, () => closeReal(real));
  onCleanup(t, () => ours.driver.close());
  await real.init();
  await ours.init();
  for (const [index, op] of SCENARIO.entries()) {
    const expected = await outcome(() => op(real));
    const actual = await outcome(() => op(ours));
    assert.deepStrictEqual(actual, expected, `step ${index}: ${op.toString()}`);
  }
});

test("normalKeys treats dots literally, like quick.db", async (t) => {
  const dir = tempDir(t);
  const real = new Real.QuickDB({ filePath: join(dir, "real.sqlite"), normalKeys: true });
  const ours = new QuickDB({ filePath: join(dir, "ours.sqlite"), normalKeys: true });
  onCleanup(t, () => closeReal(real));
  onCleanup(t, () => ours.driver.close());
  for (const db of [real, ours]) {
    await db.set("a.b", 1);
    assert.equal(await db.get("a.b"), 1);
    assert.deepEqual(await db.all(), [{ id: "a.b", value: 1 }]);
    db.useNormalKeys(false);
    assert.equal(await db.get("a.b"), undefined);
    db.useNormalKeys(true);
  }
});

test("reads a file written by the real quick.db (no conversion)", async (t) => {
  const file = join(tempDir(t), "json.sqlite");
  copyFileSync(join(FIXTURES, "quickdb", "json.sqlite"), file);
  const db = new QuickDB({ filePath: file });
  onCleanup(t, () => db.driver.close());
  assert.equal(await db.get("money_111"), 750);
  assert.deepEqual(await db.get("user_111"), { name: "Ayşe", level: 8 });
  assert.equal(await db.get("user_111.level"), 8);
  assert.deepEqual(await db.get("inventory_111"), ["kılıç", "kalkan"]);
  assert.equal(await db.get("flag"), false);
  assert.equal(await db.has("flag"), true);
  const economy = db.table("economy");
  assert.equal(await economy.get("bank_111"), 900);
  assert.equal(await economy.add("bank_111", 100), 1000);
  db.useNormalKeys(true);
  assert.equal(await db.get("dotted.key"), "literal");
  assert.equal((await db.all()).length, 7);
});

test("files written by the compat layer stay readable by the real quick.db", async (t) => {
  const file = join(tempDir(t), "json.sqlite");
  const ours = new QuickDB({ filePath: file });
  await ours.set("user.name", "Ayşe");
  await ours.push("list", 1, 2);
  await ours.table("economy").add("bank", 10);
  ours.driver.close();
  const real = new Real.QuickDB({ filePath: file });
  onCleanup(t, () => closeReal(real));
  assert.deepEqual(await real.get("user"), { name: "Ayşe" });
  assert.deepEqual(await real.get("list"), [1, 2]);
  assert.equal(await real.table("economy").get("bank"), 10);
});

test("intentional difference: pull(key, value, true) removes only the first match", async (t) => {
  const db = new QuickDB({ driver: new MemoryDriver() });
  onCleanup(t, () => db.driver.close());
  await db.set("x", [1, 2, 1, 3]);
  assert.deepEqual(await db.pull("x", 1, true), [2, 1, 3]);
  // quick.db 9.1.7 returns [2] here: it stops copying after the first kept element.
  assert.deepEqual(await db.pull("x", (v) => v > 1, true), [1, 3]);
});

test("intentional difference: delete() honours normalKeys", async (t) => {
  const db = new QuickDB({ driver: new MemoryDriver(), normalKeys: true });
  onCleanup(t, () => db.driver.close());
  await db.set("a.b", 1);
  assert.equal(await db.delete("a.b"), 1);
  assert.deepEqual(await db.all(), []);
});

test("drivers: only Depo's own drivers are accepted; tables share the driver", async (t) => {
  await assert.rejects(async () => new QuickDB({ driver: new Real.MemoryDriver() }), /only supports its own/);
  const driver = new SqliteDriver(join(tempDir(t), "d.sqlite"));
  onCleanup(t, () => driver.close());
  const db = new QuickDB({ driver, table: "custom" });
  const other = await db.tableAsync("other");
  assert.equal(other.driver, driver);
  await db.set("k", 1);
  assert.equal(await other.get("k"), null);
  assert.deepEqual(await driver.getRowByKey("custom", "k"), [1, true]);
  assert.deepEqual(await driver.getAllRows("custom"), [{ id: "k", value: 1 }]);
  assert.equal(await driver.deleteRowByKey("custom", "k"), 1);
});

test("table names are quoted, not interpolated", async (t) => {
  const db = new QuickDB({ driver: new MemoryDriver(), table: 'weird "name"; DROP TABLE json; --' });
  onCleanup(t, () => db.driver.close());
  await db.set("k", 1);
  assert.equal(await db.get("k"), 1);
});

test("createSingleton returns one shared instance", async (t) => {
  const a = QuickDB.createSingleton({ driver: new MemoryDriver() });
  const b = QuickDB.createSingleton();
  onCleanup(t, () => a.driver.close());
  assert.equal(a, b);
});
