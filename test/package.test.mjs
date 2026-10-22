import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

test("package.json invariants", async () => {
  const { VERSION } = await import("depo");
  assert.equal(VERSION, pkg.version);
  assert.equal(pkg.private, true, "stays private until a name is chosen");
  assert.equal(pkg.dependencies, undefined, "zero runtime dependencies");
  assert.equal(pkg.engines.node, ">=24.15.0");
});

test("every entry point loads through the exports map in ESM and CJS", async () => {
  const esm = await import("depo");
  const cjs = require("depo");
  for (const mod of [esm, cjs]) {
    assert.equal(typeof mod.Depo, "function");
    assert.equal(typeof mod.DepoError, "function");
    assert.equal(typeof mod.escapeKey, "function");
    const db = new mod.Depo(":memory:");
    db.set("k", 1);
    assert.equal(db.add("k", 1), 2);
    db.close();
  }
  for (const mod of [await import("depo/quickdb"), require("depo/quickdb")]) {
    assert.deepEqual(Object.keys(mod).sort(), ["MemoryDriver", "QuickDB", "SqliteDriver"]);
    const db = new mod.QuickDB({ driver: new mod.MemoryDriver() });
    assert.equal(await db.add("k", 2), 2);
    db.driver.close();
  }
  for (const mod of [await import("depo/wiodb"), require("depo/wiodb")]) {
    assert.deepEqual(Object.keys(mod).sort(), ["DatabaseError", "JsonDatabase"]);
  }
  assert.throws(() => require("depo/dist/cjs/store.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});
