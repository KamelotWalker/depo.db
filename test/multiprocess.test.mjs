import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { Depo } from "../dist/esm/index.js";
import { QuickDB } from "../dist/esm/compat/quickdb.js";
import { JsonDatabase } from "../dist/esm/compat/wiodb.js";
import { onCleanup, ROOT, tempDir } from "./helpers.mjs";

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

// Holds the write lock of the file in argv[1] for argv[2] ms; prints "locked" once it has it.
const HOLD_LOCK = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
console.log("locked");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[2]));`;

/** Calls add() while another process holds the lock and the wall clock jumps by `clockStep` ms after 20 ms. */
async function addWhileLocked(db, holdMs, clockStep) {
  const holder = spawn(process.execPath, ["-e", HOLD_LOCK, db.path, String(holdMs)], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(holder, "exit");
  await once(holder.stdout, "data");
  const realNow = Date.now;
  const start = performance.now();
  Date.now = () => realNow() + (performance.now() - start > 20 ? clockStep : 0);
  try {
    return { result: db.add("counter", 1), elapsed: performance.now() - start };
  } catch (error) {
    return { error, elapsed: performance.now() - start };
  } finally {
    Date.now = realNow;
    await exited;
  }
}

test("busyTimeout is measured on the monotonic clock: wall-clock steps neither stretch nor cut it", async (t) => {
  const dir = tempDir(t);
  const short = new Depo(join(dir, "short.sqlite"), { busyTimeout: 100 });
  onCleanup(t, () => short.close());
  short.set("counter", 0);
  // Clock set back 10 s: a wall-clock deadline would keep waiting until the 1.5 s lock is released.
  const back = await addWhileLocked(short, 1500, -10_000);
  assert.match(String(back.error), /database is locked/, `add() returned ${back.result} after ${Math.round(back.elapsed)} ms`);
  assert.ok(back.elapsed < 1000, `gave up after ${Math.round(back.elapsed)} ms`);
  assert.equal(short.get("counter"), 0);

  const long = new Depo(join(dir, "long.sqlite"), { busyTimeout: 5000 });
  onCleanup(t, () => long.close());
  long.set("counter", 0);
  // Clock set forward 10 s: a wall-clock deadline would give up long before the 300 ms lock is released.
  const forward = await addWhileLocked(long, 300, 10_000);
  assert.equal(forward.error, undefined, `add() failed after ${Math.round(forward.elapsed)} ms: ${forward.error}`);
  assert.equal(forward.result, 1);
});
