import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

test("package.json invariants", async () => {
  const { VERSION } = await import("zula");
  assert.equal(VERSION, pkg.version);
  assert.equal(pkg.name, "zula");
  assert.deepEqual(pkg.bin, { zula: "./dist/cjs/cli.js" });
  assert.equal(pkg.dependencies, undefined, "zero runtime dependencies");
  assert.equal(pkg.engines.node, ">=24.15.0");
});

test("every entry point loads through the exports map in ESM and CJS", async () => {
  const esm = await import("zula");
  const cjs = require("zula");
  for (const mod of [esm, cjs]) {
    assert.deepEqual(Object.keys(mod).sort(), ["DEFAULT_NAMESPACE", "DEFAULT_PATH", "VERSION", "Zula", "ZulaError", "escapeKey"]);
    assert.equal(mod.DEFAULT_PATH, "zula.sqlite");
    assert.equal(new mod.ZulaError("invalid").name, "ZulaError");
    assert.equal(typeof mod.Zula, "function");
    assert.equal(typeof mod.ZulaError, "function");
    assert.equal(typeof mod.escapeKey, "function");
    const db = new mod.Zula(":memory:");
    db.set("k", 1);
    assert.equal(db.add("k", 1), 2);
    db.close();
  }
  for (const mod of [await import("zula/quickdb"), require("zula/quickdb")]) {
    assert.deepEqual(Object.keys(mod).sort(), ["MemoryDriver", "QuickDB", "SqliteDriver"]);
    const db = new mod.QuickDB({ driver: new mod.MemoryDriver() });
    assert.equal(await db.add("k", 2), 2);
    db.driver.close();
  }
  for (const mod of [await import("zula/wiodb"), require("zula/wiodb")]) {
    assert.deepEqual(Object.keys(mod).sort(), ["DatabaseError", "JsonDatabase"]);
  }
  assert.throws(() => require("zula/dist/cjs/store.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("loading the package prints no warnings (no ExperimentalWarning on Node >= 24.15)", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const code of ['require("zula")', 'require("zula/quickdb")', 'require("zula/wiodb")']) {
    const run = spawnSync(process.execPath, ["-e", `${code}; new (require("zula").Zula)(":memory:").close()`], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "", `${code} wrote to stderr`);
  }
});
