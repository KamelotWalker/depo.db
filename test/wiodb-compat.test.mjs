import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { Depo } from "../dist/esm/index.js";
import { DatabaseError, JsonDatabase } from "../dist/esm/compat/wiodb.js";
import { FIXTURES, onCleanup, tempDir } from "./helpers.mjs";

// The real wio.db 4.0.22 is a devDependency used as the reference implementation.
const require = createRequire(import.meta.url);
const Real = require("wio.db");

const byId = (list) => [...list].sort((a, b) => (a.ID < b.ID ? -1 : a.ID > b.ID ? 1 : 0));
const byJson = (list) => [...list].map((v) => JSON.stringify(v)).sort();

/** Operations run against both implementations; every result or error message must match. */
const SCENARIO = [
  (db) => db.get("missing"),
  (db) => db.get("missing", 5),
  (db) => db.fetch("missing"),
  (db) => db.set("a", 1),
  (db) => db.get("a"),
  (db) => db.set("a", ""),
  (db) => db.set("a", null),
  (db) => db.set("a", undefined),
  (db) => db.set("", 1),
  (db) => db.set(5, 1),
  (db) => db.set("a", 1, "yes"),
  (db) => db.get(""),
  (db) => db.set("zero", 0),
  (db) => db.get("zero", "default"),
  (db) => db.set("user.312345678901234567.name", "Ayşe"),
  (db) => db.set("user.312345678901234567.level", 7),
  (db) => db.get("user"),
  (db) => db.get("user.312345678901234567.name"),
  (db) => db.set("slots.2", "x"),
  (db) => db.get("slots"),
  (db) => db.set("list", [1, 2, 3]),
  (db) => db.get("list.1"),
  (db) => db.get("list.length"),
  (db) => db.get("list[2]"),
  (db) => db.set("brack.items[0].name", "n"),
  (db) => db.get("brack"),
  (db) => db.set("prim", 5),
  (db) => db.set("prim.x", 1),
  (db) => db.get("prim"),
  (db) => db.set("unicode_ğüşİ", "değer 🎉"),
  (db) => db.get("unicode_ğüşİ"),
  (db) => db.exists("a"),
  (db) => db.has("user.312345678901234567"),
  (db) => db.exists("missing"),
  (db) => db.type("a"),
  (db) => db.type("list"),
  (db) => db.type("user"),
  (db) => db.type("missing"),
  (db) => db.type("unicode_ğüşİ"),
  (db) => db.add("coins", 5),
  (db) => db.add("coins", "3"),
  (db) => db.add("coins", 0),
  (db) => db.add("coins", -1),
  (db) => db.add("coins", "abc"),
  (db) => db.add("coins", [1]),
  (db) => db.add("list", 1),
  (db) => db.add("user.312345678901234567.level", 1),
  (db) => db.substr("coins", 2),
  (db) => db.substr("coins", 100),
  (db) => db.get("coins"),
  (db) => db.set("m", 4),
  (db) => db.math("m", "*", 3),
  (db) => db.math("m", "/", 4),
  (db) => db.math("m", "%", 2),
  (db) => db.math("m", "^", 2),
  (db) => db.math("m", "+", 1, "no"),
  (db) => db.set("neg", 3),
  (db) => db.substr("neg", 5, true),
  (db) => db.push("inv", "kılıç"),
  (db) => db.push("inv", "kalkan"),
  (db) => db.push("a", "x"),
  (db) => db.get("a"),
  (db) => db.pull("inv", (e) => e === "kılıç"),
  (db) => db.pull("missing", () => true),
  (db) => db.set("seven", 7),
  (db) => db.pull("seven", () => true),
  (db) => db.pull("inv", () => true, "yes"),
  (db) => db.set("nums", [1, 2, 3, 2]),
  (db) => db.pull("nums", (e) => e === 2),
  (db) => db.pull("nums", (e) => e > 1, true),
  (db) => db.pull("nums", function (e) { return e === this.target; }, false, { target: 1 }),
  (db) => db.delete("user.312345678901234567.name"),
  (db) => db.get("user"),
  (db) => db.delete("list[0]"),
  (db) => db.get("list"),
  (db) => db.delete("a"),
  (db) => db.get("a"),
  (db) => db.delete("never.existed"),
  (db) => db.delete(""),
  (db) => db.delete("a", "x"),
  (db) => byId(db.all()),
  (db) => db.all("x"),
  (db) => db.toJSON(),
  (db) => db.keyArray().sort(),
  (db) => byJson(db.valueArray()),
  (db) => byId(db.includes("o")),
  (db) => byId(db.startsWith("u")),
  (db) => byId(db.filter((e) => typeof e.data === "number")),
  (db) => byId(db.filter(function (e) { return e.ID === this.id; }, { id: "m" })),
  (db) => db.sort((a, b) => (a.ID < b.ID ? 1 : -1)),
  (db) => db.findAndDelete((e) => e.ID.startsWith("s")),
  (db) => db.keyArray().sort(),
  (db) => db.deleteAll(),
  (db) => db.all(),
];

function outcome(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    // wio.db wraps messages in ANSI colours plus an advertisement line; compare the message itself.
    return { error: error.message.replace(/\u001b\[\d+m/g, "").split("\n")[0] };
  }
}

test("behaves like wio.db 4.0.22 on a shared scenario", (t) => {
  const dir = tempDir(t);
  const real = new Real.JsonDatabase({ databasePath: join(dir, "real.json") });
  const ours = new JsonDatabase({ databasePath: join(dir, "ours.json") });
  onCleanup(t, () => ours.close());
  for (const [index, op] of SCENARIO.entries()) {
    const expected = outcome(() => op(real));
    const actual = outcome(() => op(ours));
    assert.deepStrictEqual(actual, expected, `step ${index}: ${op.toString()}`);
  }
});

test("imports an existing wio.db JSON file once, without touching it", (t) => {
  const dir = tempDir(t);
  const json = join(dir, "db.json");
  copyFileSync(join(FIXTURES, "wio", "db.json"), json);
  const before = readFileSync(json, "utf8");
  const reference = new Real.JsonDatabase({ databasePath: json }).toJSON();

  const db = new JsonDatabase({ databasePath: json });
  assert.equal(db.path, join(dir, "db.sqlite"));
  assert.deepStrictEqual(db.toJSON(), reference);
  assert.equal(db.get("user.312345678901234567.name"), "Ayşe");
  assert.deepEqual(db.get("slots"), [null, null, "x"]);
  assert.equal(db.get("emoji_🎉"), "parti");
  assert.equal(db.add("money_111", 50), 800);
  db.close();
  assert.equal(readFileSync(json, "utf8"), before, "JSON file untouched");

  // A second open must not re-import (the 800 would be reset to 750).
  writeFileSync(json, JSON.stringify({ money_111: 1 }));
  const again = new JsonDatabase({ databasePath: json });
  assert.equal(again.get("money_111"), 800);
  again.close();

  // The same file is a regular Depo database in the default namespace.
  const native = new Depo(join(dir, "db.sqlite"));
  assert.equal(native.get("user.312345678901234567.level"), 7);
  native.close();
});

test("importJson: false starts empty; databasePath rules follow wio.db", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "db.json"), JSON.stringify({ a: 1 }));
  const db = new JsonDatabase({ databasePath: join(dir, "db"), importJson: false });
  onCleanup(t, () => db.close());
  assert.equal(db.jsonPath, join(dir, "db.json"));
  assert.equal(db.get("a"), null);
  const nested = new JsonDatabase({ databasePath: join(dir, "deeper", "more") + "/" });
  onCleanup(t, () => nested.close());
  assert.equal(nested.path, join(dir, "deeper", "more", "db.sqlite"));
});

test("lone surrogates: allowed in nested path segments like wio.db, rejected as top-level keys", (t) => {
  const dir = tempDir(t);
  const data = JSON.stringify({ obj: { "\ud800": 1, "\ud801": 2 } });
  writeFileSync(join(dir, "real.json"), data);
  writeFileSync(join(dir, "ours.json"), data);
  const real = new Real.JsonDatabase({ databasePath: join(dir, "real.json") });
  const ours = new JsonDatabase({ databasePath: join(dir, "ours.json") });
  onCleanup(t, () => ours.close());
  for (const db of [real, ours]) {
    assert.equal(db.get("obj.\ud800"), 1);
    assert.equal(db.set("obj.\ud801", 3), 3);
    db.add("obj.\ud801", 1);
    db.delete("obj.\ud800");
    assert.deepEqual(db.get("obj"), { "\ud801": 4 });
  }
  // Only the SQLite row key must be well-formed (see compat-wiodb.md, difference 17).
  assert.throws(() => ours.set("top_\ud800", 1), /lone UTF-16 surrogate/);
  assert.throws(() => ours.set("top_\ud800.x", 1), /lone UTF-16 surrogate/);
});

test("intentional difference: math on a missing or zero value starts from 0", (t) => {
  const db = new JsonDatabase({ databasePath: join(tempDir(t), "db.json") });
  onCleanup(t, () => db.close());
  // wio.db 4.0.22 stores +value in all of these cases.
  assert.equal(db.substr("a", 5), 0);
  assert.equal(db.substr("b", 5, true), -5);
  assert.equal(db.math("c", "*", 3), 0);
  db.set("d", 0);
  assert.equal(db.substr("d", 2, true), -2);
  assert.equal(db.add("e", 5), 5, "add is unaffected");
});

test("intentional difference: pull with no match removes nothing", (t) => {
  const db = new JsonDatabase({ databasePath: join(tempDir(t), "db.json") });
  onCleanup(t, () => db.close());
  db.set("list", [1, 2, 3]);
  // wio.db 4.0.22 splices index -1 and drops the last element.
  assert.deepEqual(db.pull("list", (e) => e === 99), [1, 2, 3]);
});

test("intentional differences: key order, size, maxDataSize, destroy, errors", (t) => {
  const dir = tempDir(t);
  const db = new JsonDatabase({ databasePath: join(dir, "db.json"), maxDataSize: 2 });
  db.set("b", 1);
  db.set("a", 1);
  assert.deepEqual(db.keyArray(), ["a", "b"], "ordered by key");
  assert.deepEqual(db.all(1), [{ ID: "a", data: 1 }]);
  assert.equal(db.size, 2);
  assert.deepEqual(db.info, { size: 2, version: "0.1.0" });
  db.set("a", 2);
  db.set("a.nested", 3);
  assert.throws(() => db.set("c", 1), (error) => error instanceof DatabaseError && error.message === "Data limit exceeded!");
  assert.throws(() => new JsonDatabase({ maxDataSize: 0 }), /Inappropriate range/);
  assert.throws(() => new JsonDatabase({ maxDataSize: "5" }), /must be in number type/);
  db.destroy();
  assert.equal(existsSync(join(dir, "db.sqlite")), false);
  assert.throws(() => db.get("a"), /closed/);
});
