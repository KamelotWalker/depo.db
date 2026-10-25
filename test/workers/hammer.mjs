// Worker for test/multiprocess.test.mjs. Usage:
//   node hammer.mjs <mode> <file> <iterations> <workerId> <startAt>
// Waits until <startAt> (epoch ms) so all workers collide, then hammers one file.
// A short random pause after each iteration releases the write lock so the
// workers interleave instead of running one after another.
import { Depo } from "../../dist/esm/index.js";
import { QuickDB, SqliteDriver } from "../../dist/esm/compat/quickdb.js";
import { JsonDatabase } from "../../dist/esm/compat/wiodb.js";

const [mode, file, iterationsArg, workerId, startAtArg] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const startAt = Number(startAtArg);
const pause = () => new Promise((resolve) => setTimeout(resolve, Math.random() < 0.5 ? 0 : 1));
// Six processes writing flat out with fsync on every commit is far beyond normal
// bot traffic; single operations can then wait seconds for the write lock (see
// docs/decisions.md). This test checks atomicity, so it allows long waits.
const BUSY_TIMEOUT = 60_000;

while (Date.now() < startAt) await new Promise((resolve) => setTimeout(resolve, 1));

if (mode === "native") {
  const db = new Depo(file, { busyTimeout: BUSY_TIMEOUT });
  const bank = db.table("bank");
  for (let i = 0; i < iterations; i++) {
    db.add("counter", 1);
    db.push("list", `${workerId}:${i}`);
    db.add(["stats", `w${workerId}`], 1);
    // Multi-key transfer: the total must stay constant.
    db.transaction(() => {
      bank.subtract("alice", 1);
      bank.add("bob", 1);
    });
    await pause();
  }
  db.close();
} else if (mode === "naive") {
  // Deliberately unsafe read-then-write without a transaction (control group).
  const db = new Depo(file, { busyTimeout: BUSY_TIMEOUT });
  for (let i = 0; i < iterations; i++) {
    const current = db.get("counter", 0);
    db.set("counter", current + 1);
    await pause();
  }
  db.close();
} else if (mode === "quickdb") {
  const db = new QuickDB({ driver: new SqliteDriver(file, { busyTimeout: BUSY_TIMEOUT }) });
  for (let i = 0; i < iterations; i++) {
    await db.add("counter", 1);
    await db.push("list", `${workerId}:${i}`);
    await db.add(`stats.w${workerId}`, 1);
    await pause();
  }
  db.driver.close();
} else if (mode === "wiodb") {
  const db = new JsonDatabase({ databasePath: file, busyTimeout: BUSY_TIMEOUT });
  for (let i = 0; i < iterations; i++) {
    db.add("counter", 1);
    db.push("list", `${workerId}:${i}`);
    db.add(`stats.w${workerId}`, 1);
    await pause();
  }
  db.close();
} else {
  throw new Error(`unknown mode ${mode}`);
}
