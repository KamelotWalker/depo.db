// Packs the library, installs the tarball into a throwaway consumer project
// under .tmp/smoke and checks that plain ESM, plain CommonJS and TypeScript
// (node16/nodenext and bundler resolution) consumers work.
//
//   npm run build && npm run smoke
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = join(root, ".tmp", "smoke");

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/** npm is a .cmd shim on Windows, which needs a shell; quote every argument ourselves. */
function npm(args, cwd) {
  const line = ["npm", ...args.map((arg) => JSON.stringify(arg))].join(" ");
  return execSync(line, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", work], root));
const tarball = join(work, packed[0].filename);
console.log(`packed ${packed[0].filename}: ${packed[0].entryCount} files, ${packed[0].size} bytes`);

const app = join(work, "app");
mkdirSync(app);
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke-app", private: true }, null, 2));
npm(["install", "--no-audit", "--no-fund", "--offline", tarball], app);

writeFileSync(
  join(app, "esm.mjs"),
  `import assert from "node:assert/strict";
import { Depo, Leaderboard } from "depo.db";
import { QuickDB } from "depo.db/quickdb";
import { JsonDatabase } from "depo.db/wiodb";
const db = new Depo("esm.sqlite");
db.set("user.1.name", "Ayşe");
db.add("coins", 5);
const board = db.leaderboard("xp");
assert.ok(board instanceof Leaderboard);
assert.equal(board.add("user.1", 10), 10);
assert.deepEqual(board.top(), [{ member: "user.1", score: 10, rank: 1 }]);
assert.equal(board.rank("user.1"), 1);
assert.equal(db.rateLimit("command.user.1", { limit: 1, window: 60_000 }).allowed, true);
assert.equal(db.rateLimit("command.user.1", { limit: 1, window: 60_000 }).allowed, false);
assert.equal(db.resetRateLimit("command.user.1"), true);
const q = new QuickDB({ filePath: "esm-quick.sqlite" });
await q.add("coins", 5);
const w = new JsonDatabase({ databasePath: "esm-wio.json" });
w.add("coins", 5);
console.log("esm", db.get("user.1.name"), db.get("coins"), await q.get("coins"), w.get("coins"));
db.close(); q.driver.close(); w.close();
`,
);
writeFileSync(
  join(app, "cjs.cjs"),
  `const assert = require("node:assert/strict");
const { Depo, Leaderboard } = require("depo.db");
const { QuickDB } = require("depo.db/quickdb");
const { JsonDatabase } = require("depo.db/wiodb");
(async () => {
  const db = new Depo("cjs.sqlite");
  db.push("list", 1, 2);
  const board = db.leaderboard("xp");
  assert.ok(board instanceof Leaderboard);
  assert.equal(board.set("user.1", 10), 10);
  assert.equal(board.add("user.1", 5), 15);
  assert.equal(board.score("user.1"), 15);
  assert.equal(board.rank("user.1"), 1);
  assert.equal(board.top(1)[0].member, "user.1");
  assert.equal(board.count(), 1);
  assert.equal(board.remove("user.1"), true);
  assert.equal(board.clear(), 0);
  assert.equal(db.rateLimit("command.user.1", { limit: 1, window: 60_000 }).remaining, 0);
  assert.equal(db.resetRateLimit("command.user.1"), true);
  const q = new QuickDB({ filePath: "cjs-quick.sqlite" });
  await q.push("list", 1, 2);
  const w = new JsonDatabase({ databasePath: "cjs-wio.json" });
  w.push("list", 1);
  console.log("cjs", JSON.stringify(db.get("list")), JSON.stringify(await q.get("list")), JSON.stringify(w.get("list")));
  db.close(); q.driver.close(); w.close();
})();
`,
);
writeFileSync(
  join(app, "consumer.ts"),
  `import { Depo, DepoError, Leaderboard, escapeKey, type Entry, type Key, type DepoOptions, type LeaderboardEntry, type RateLimitOptions, type RateLimitResult } from "depo.db";
import { QuickDB, MemoryDriver } from "depo.db/quickdb";
import { JsonDatabase, type Schema } from "depo.db/wiodb";
const options: DepoOptions = { synchronous: "normal" };
const db = new Depo(":memory:", options);
const key: Key = ["a", escapeKey("b.c")];
const n: number = db.add(key, 1);
const entries: Entry<number>[] = db.all<number>();
const board: Leaderboard = db.leaderboard("xp");
const score: number = board.add("user.1", 5);
const rank: number | undefined = board.rank("user.1");
const top: LeaderboardEntry[] = board.top(10);
const rateOptions: RateLimitOptions = { limit: 3, window: 10_000 };
const result: RateLimitResult = db.rateLimit("command.user.1", rateOptions);
const reset: boolean = db.resetRateLimit("command.user.1");
const q = new QuickDB<number>({ driver: new MemoryDriver() });
const p: Promise<number | null> = q.get("x");
const w = new JsonDatabase<number>({ databasePath: "x.json" });
const rows: Schema<number>[] = w.all();
export { n, entries, p, rows, score, rank, top, result, reset, DepoError };
`,
);

console.log(run(process.execPath, ["esm.mjs"], app).trim());
console.log(run(process.execPath, ["cjs.cjs"], app).trim());
assert.match(npm(["exec", "--offline", "--", "depo", "--help"], app), /^Usage: depo migrate <source>/);
console.log("depo --help ok");

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
for (const [module, moduleResolution] of [
  ["nodenext", "nodenext"],
  ["node16", "node16"],
  ["esnext", "bundler"],
  ["commonjs", "bundler"],
]) {
  run(
    process.execPath,
    [tsc, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "false", "--types", "node", "--typeRoots", join(root, "node_modules", "@types"),
      "--module", module, "--moduleResolution", moduleResolution, "consumer.ts"],
    app,
  );
  console.log(`tsc ok: module=${module} moduleResolution=${moduleResolution}`);
}
console.log("smoke ok");
