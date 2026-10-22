import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { Depo } from "../dist/esm/index.js";
import { QuickDB } from "../dist/esm/compat/quickdb.js";
import { JsonDatabase } from "../dist/esm/compat/wiodb.js";
import { ROOT, tempDir } from "./helpers.mjs";

const WORKERS = 6;
const ITERATIONS = 150;
const HAMMER = join(ROOT, "test", "workers", "hammer.mjs");

/** Starts WORKERS processes that begin at the same instant; resolves when all exit. */
async function hammer(mode, file) {
  const startAt = Date.now() + 750;
  const runs = [];
  for (let id = 0; id < WORKERS; id++) {
    runs.push(
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [HAMMER, mode, file, String(ITERATIONS), String(id), String(startAt)], {
          stdio: ["ignore", "inherit", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${id} exited ${code}\n${stderr}`))));
      }),
    );
  }
  await Promise.all(runs);
}

function expectedList() {
  const list = [];
  for (let id = 0; id < WORKERS; id++) for (let i = 0; i < ITERATIONS; i++) list.push(`${id}:${i}`);
  return list.sort();
}

test("native API: add, push, path add and transactions are atomic across processes", async (t) => {
  const file = join(tempDir(t), "shared.sqlite");
  const setup = new Depo(file);
  setup.table("bank").set("alice", 1_000_000);
  setup.table("bank").set("bob", 0);
  setup.close();

  await hammer("native", file);

  const db = new Depo(file);
  const total = WORKERS * ITERATIONS;
  assert.equal(db.get("counter"), total, "no lost add()");
  assert.deepEqual([...db.get("list")].sort(), expectedList(), "no lost or duplicated push()");
  for (let id = 0; id < WORKERS; id++) assert.equal(db.get(["stats", `w${id}`]), ITERATIONS);
  const bank = db.table("bank");
  assert.equal(bank.get("bob"), total);
  assert.equal(bank.get("alice") + bank.get("bob"), 1_000_000, "transfers conserve the total");
  db.close();
});

test("control: unsynchronised get-then-set from several processes is not atomic", async (t) => {
  const file = join(tempDir(t), "naive.sqlite");
  await hammer("naive", file);
  const db = new Depo(file);
  const counter = db.get("counter");
  db.close();
  // Proves the workers really overlap: without a transaction, updates get lost
  // (typically most of them). If this ever fails, the atomicity tests above
  // are not exercising contention.
  t.diagnostic(`naive counter: ${counter} of ${WORKERS * ITERATIONS} (${WORKERS * ITERATIONS - counter} lost updates)`);
  assert.ok(counter < WORKERS * ITERATIONS, "expected lost updates in the unsynchronised control");
});

test("quick.db compat: add and push are atomic across processes", async (t) => {
  const file = join(tempDir(t), "json.sqlite");
  await hammer("quickdb", file);
  const db = new QuickDB({ filePath: file });
  assert.equal(await db.get("counter"), WORKERS * ITERATIONS);
  assert.deepEqual([...(await db.get("list"))].sort(), expectedList());
  for (let id = 0; id < WORKERS; id++) assert.equal(await db.get(`stats.w${id}`), ITERATIONS);
  db.driver.close();
});

test("wio.db compat: add and push are atomic across processes", async (t) => {
  const file = join(tempDir(t), "db.json");
  await hammer("wiodb", file);
  const db = new JsonDatabase({ databasePath: file });
  assert.equal(db.get("counter"), WORKERS * ITERATIONS);
  assert.deepEqual([...db.get("list")].sort(), expectedList());
  for (let id = 0; id < WORKERS; id++) assert.equal(db.get(`stats.w${id}`), ITERATIONS);
  db.close();
});
