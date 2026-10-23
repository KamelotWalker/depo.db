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
  `import { Zula } from "zula";
import { QuickDB } from "zula/quickdb";
import { JsonDatabase } from "zula/wiodb";
const db = new Zula("esm.sqlite");
db.set("user.1.name", "Ayşe");
db.add("coins", 5);
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
  `const { Zula } = require("zula");
const { QuickDB } = require("zula/quickdb");
const { JsonDatabase } = require("zula/wiodb");
(async () => {
  const db = new Zula("cjs.sqlite");
  db.push("list", 1, 2);
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
  `import { Zula, ZulaError, escapeKey, type Entry, type Key, type ZulaOptions } from "zula";
import { QuickDB, MemoryDriver } from "zula/quickdb";
import { JsonDatabase, type Schema } from "zula/wiodb";
const options: ZulaOptions = { synchronous: "normal" };
const db = new Zula(":memory:", options);
const key: Key = ["a", escapeKey("b.c")];
const n: number = db.add(key, 1);
const entries: Entry<number>[] = db.all<number>();
const q = new QuickDB<number>({ driver: new MemoryDriver() });
const p: Promise<number | null> = q.get("x");
const w = new JsonDatabase<number>({ databasePath: "x.json" });
const rows: Schema<number>[] = w.all();
export { n, entries, p, rows, ZulaError };
`,
);

console.log(run(process.execPath, ["esm.mjs"], app).trim());
console.log(run(process.execPath, ["cjs.cjs"], app).trim());
assert.match(npm(["exec", "--offline", "--", "zula", "--help"], app), /^Usage: zula migrate <source>/);
console.log("zula --help ok");

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
