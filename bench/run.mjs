// Reproducible benchmark: Depo vs quick.db (+ better-sqlite3) vs wio.db.
//
//   npm run bench            (builds first)
//
// Every (library, workload, run) executes in a fresh child process and a fresh
// directory under bench/.work, so JIT warm-up, caches and file state never leak
// between measurements. Results replace the block between the markers in
// docs/benchmark.md; the commentary around it is kept.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, platform, release, totalmem, arch } from "node:os";
import { join } from "node:path";
import { SIZES } from "./worker.mjs";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");
const work = join(import.meta.dirname, ".work");
const worker = join(import.meta.dirname, "worker.mjs");
const doc = join(root, "docs", "benchmark.md");
const RUNS = 3;
const COLD_RUNS = 7;
const CHILD_TIMEOUT_MS = 10 * 60_000;

const LIBRARIES = [
  ["depo", "Depo (default: WAL, synchronous FULL)"],
  ["depo-normal", 'Depo (synchronous: "normal")'],
  ["depo-quickdb", "depo/quickdb compat layer"],
  ["quickdb", "quick.db 9.1.7 + better-sqlite3"],
  ["wiodb", "wio.db 4.0.22"],
];

const WORKLOADS = [
  ["set", `set() ${SIZES.set} new keys, one call each`],
  ["get", `get() ${SIZES.get} random reads over ${SIZES.getKeys} keys`],
  ["add", `add() ${SIZES.add} times on one hot key`],
  ["bulk-loop", `bulk insert ${SIZES.bulk} keys with a set() loop`],
  ["bulk-tx", `bulk insert ${SIZES.bulk} keys in one transaction (Depo only: the others have no transaction API)`],
];

const version = (pkg) => JSON.parse(readFileSync(require.resolve(`${pkg}/package.json`), "utf8")).version;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function runWorker(library, workload, dir) {
  const result = spawnSync(process.execPath, [worker, library, workload, dir], {
    cwd: dir,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  if (result.error?.code === "ETIMEDOUT") return { timedOut: true };
  if (result.status !== 0) throw new Error(`${library}/${workload} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function freshDir(name) {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const value = (i) => ({ id: i, name: `user${i}`, coins: i * 10, tags: ["a", "b"] });

/** Builds each library's on-disk format with SIZES.coldKeys entries, once. */
async function prepareColdTemplates() {
  const templates = {};
  const { Depo } = await import(new URL("../dist/esm/index.js", import.meta.url).href);
  for (const [library] of LIBRARIES) {
    const dir = freshDir(`template-${library}`);
    if (library.startsWith("depo") && library !== "depo-quickdb") {
      const db = new Depo(join(dir, "depo.sqlite"));
      db.transaction(() => {
        for (let i = 0; i < SIZES.coldKeys; i++) db.set(`user_${i}`, value(i));
      });
      db.close();
    } else if (library === "depo-quickdb" || library === "quickdb") {
      // quick.db's own table layout, written directly through better-sqlite3.
      const Database = require("better-sqlite3");
      const db = new Database(join(dir, "json.sqlite"));
      db.exec("CREATE TABLE IF NOT EXISTS json (ID TEXT PRIMARY KEY, json TEXT)");
      const insert = db.prepare("INSERT INTO json (ID, json) VALUES (?, ?)");
      db.transaction(() => {
        for (let i = 0; i < SIZES.coldKeys; i++) insert.run(`user_${i}`, JSON.stringify(value(i)));
      })();
      db.close();
    } else {
      const data = {};
      for (let i = 0; i < SIZES.coldKeys; i++) data[`user_${i}`] = value(i);
      writeFileSync(join(dir, "db.json"), JSON.stringify(data, null, 4));
    }
    templates[library] = dir;
  }
  return templates;
}

function fileSizes(dir) {
  let total = 0;
  for (const name of ["depo.sqlite", "json.sqlite", "db.json"]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = join(dir, name + suffix);
      if (existsSync(file)) total += statSync(file).size;
    }
  }
  return total;
}

function fmt(n, digits = 0) {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const results = {};

  for (const [workload] of WORKLOADS) {
    for (const [library] of LIBRARIES) {
      // Only the native API has transactions.
      if (workload === "bulk-tx" && (library === "depo-quickdb" || !library.startsWith("depo"))) continue;
      const samples = [];
      for (let run = 0; run < RUNS; run++) {
        const dir = freshDir(`${library}-${workload}-${run}`);
        const sample = runWorker(library, workload, dir);
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        if (sample.timedOut) {
          samples.length = 0;
          break;
        }
        samples.push(sample);
      }
      const ms = samples.length ? median(samples.map((s) => s.ms)) : null;
      const ops = samples[0]?.ops;
      results[`${workload}/${library}`] = ms === null ? { timedOut: true } : { ms, ops, opsPerSec: (ops / ms) * 1000 };
      console.log(workload.padEnd(10), library.padEnd(14), ms === null ? "timed out" : `${fmt(ms, 1)} ms`);
    }
  }

  const templates = await prepareColdTemplates();
  for (const [library] of LIBRARIES) {
    const samples = [];
    for (let run = 0; run < COLD_RUNS; run++) {
      const dir = freshDir(`${library}-cold-${run}`);
      cpSync(templates[library], dir, { recursive: true });
      samples.push(runWorker(library, "cold", dir));
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    results[`cold/${library}`] = {
      processToFirstGetMs: median(samples.map((s) => s.processToFirstGetMs)),
      libraryToFirstGetMs: median(samples.map((s) => s.libraryToFirstGetMs)),
      bytes: fileSizes(templates[library]),
    };
    console.log("cold".padEnd(10), library.padEnd(14), `${fmt(results[`cold/${library}`].libraryToFirstGetMs, 1)} ms`);
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return results;
}

function render(results) {
  const { DatabaseSync } = require("node:sqlite");
  const nodeSqlite = new DatabaseSync(":memory:").prepare("SELECT sqlite_version() AS v").get().v;
  const Better = require("better-sqlite3");
  const betterDb = new Better(":memory:");
  const betterSqlite = betterDb.prepare("SELECT sqlite_version() AS v").get().v;
  betterDb.close();
  const cpu = cpus();
  const lines = [];
  lines.push(`Generated ${new Date().toISOString()} by \`npm run bench\`.`);
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| CPU | ${cpu[0]?.model.trim()} (${cpu.length} logical cores) |`);
  lines.push(`| RAM | ${fmt(totalmem() / 2 ** 30, 1)} GiB |`);
  lines.push(`| OS | ${platform()} ${release()} ${arch()} |`);
  lines.push(`| Node.js | ${process.version} (node:sqlite → SQLite ${nodeSqlite}) |`);
  lines.push(`| quick.db | ${version("quick.db")} with better-sqlite3 ${version("better-sqlite3")} (SQLite ${betterSqlite}) |`);
  lines.push(`| wio.db | ${version("wio.db")} |`);
  lines.push(`| Runs | median of ${RUNS} fresh processes per cell (cold start: ${COLD_RUNS}) |`);
  lines.push(`| Storage | files under \`bench/.work\` in the repository (${root.slice(0, 2)} drive) |`);
  lines.push("");
  for (const [workload, title] of WORKLOADS) {
    lines.push(`### ${title}`);
    lines.push("");
    lines.push("| Library | Total ms | ops/s | vs Depo default |");
    lines.push("|---|---:|---:|---:|");
    const base = results[`${workload}/depo`];
    for (const [library, label] of LIBRARIES) {
      const r = results[`${workload}/${library}`];
      if (r === undefined) continue;
      if (r.timedOut) {
        lines.push(`| ${label} | timed out (> ${CHILD_TIMEOUT_MS / 60_000} min) | | |`);
        continue;
      }
      const relative = base && !base.timedOut ? `${fmt(base.ms / r.ms, 2)}×` : "";
      lines.push(`| ${label} | ${fmt(r.ms, 1)} | ${fmt(r.opsPerSec)} | ${relative} |`);
    }
    lines.push("");
  }
  lines.push(`### Cold start: open a file with ${fmt(SIZES.coldKeys)} keys and read one`);
  lines.push("");
  lines.push("| Library | Library load + open + first get (ms) | Process start → first get (ms) | Size on disk |");
  lines.push("|---|---:|---:|---:|");
  for (const [library, label] of LIBRARIES) {
    const r = results[`cold/${library}`];
    lines.push(`| ${label} | ${fmt(r.libraryToFirstGetMs, 1)} | ${fmt(r.processToFirstGetMs, 1)} | ${fmt(r.bytes / 1024)} KiB |`);
  }
  lines.push("");
  lines.push("“vs Depo default” > 1× means faster than Depo's default configuration, < 1× slower.");
  return lines.join("\n");
}

const START = "<!-- results:start -->";
const END = "<!-- results:end -->";
const results = await main();
const block = `${START}\n${render(results)}\n${END}`;
const current = existsSync(doc) ? readFileSync(doc, "utf8") : `# Benchmark\n\n${START}\n${END}\n`;
const start = current.indexOf(START);
const end = current.indexOf(END);
const next = start === -1 || end === -1 ? `${current.trimEnd()}\n\n${block}\n` : current.slice(0, start) + block + current.slice(end + END.length);
writeFileSync(doc, next);
writeFileSync(join(import.meta.dirname, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`Wrote ${doc}`);
