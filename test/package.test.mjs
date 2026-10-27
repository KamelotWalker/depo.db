import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

test("package.json invariants", async () => {
  const { VERSION } = await import("depo.db");
  assert.equal(VERSION, pkg.version);
  assert.equal(pkg.name, "depo.db");
  assert.deepEqual(pkg.bin, { depo: "dist/cjs/cli.js" });
  assert.equal(pkg.dependencies, undefined, "zero runtime dependencies");
  assert.equal(pkg.engines.node, ">=24.15.0");
});

test("every entry point loads through the exports map in ESM and CJS", async () => {
  const esm = await import("depo.db");
  const cjs = require("depo.db");
  for (const mod of [esm, cjs]) {
    assert.deepEqual(Object.keys(mod).sort(), ["DEFAULT_NAMESPACE", "DEFAULT_PATH", "Depo", "DepoError", "Leaderboard", "VERSION", "escapeKey"]);
    assert.equal(mod.DEFAULT_PATH, "depo.sqlite");
    assert.equal(new mod.DepoError("invalid").name, "DepoError");
    assert.equal(typeof mod.Depo, "function");
    assert.equal(typeof mod.DepoError, "function");
    assert.equal(typeof mod.escapeKey, "function");
    const db = new mod.Depo(":memory:");
    db.set("k", 1);
    assert.equal(db.add("k", 1), 2);
    assert.deepEqual(db.keys({ limit: 1 }), ["k"]);
    assert.deepEqual(db.all({ after: "k" }), []);
    db.close();
  }
  for (const mod of [await import("depo.db/quickdb"), require("depo.db/quickdb")]) {
    assert.deepEqual(Object.keys(mod).sort(), ["MemoryDriver", "QuickDB", "SqliteDriver"]);
    const db = new mod.QuickDB({ driver: new mod.MemoryDriver() });
    assert.equal(await db.add("k", 2), 2);
    db.driver.close();
  }
  for (const mod of [await import("depo.db/wiodb"), require("depo.db/wiodb")]) {
    assert.deepEqual(Object.keys(mod).sort(), ["DatabaseError", "JsonDatabase"]);
  }
  assert.throws(() => require("depo.db/dist/cjs/store.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("loading the package prints no warnings (no ExperimentalWarning on Node >= 24.15)", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const code of ['require("depo.db")', 'require("depo.db/quickdb")', 'require("depo.db/wiodb")']) {
    const run = spawnSync(process.execPath, ["-e", `${code}; new (require("depo.db").Depo)(":memory:").close()`], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "", `${code} wrote to stderr`);
  }
});
