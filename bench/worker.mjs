// Runs one (library, workload) pair in a fresh process and prints a JSON result.
//   node bench/worker.mjs <library> <workload> <dir>
// Spawned by bench/run.mjs; not meant to be run by hand.
import { createRequire } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const [library, workload, dir] = process.argv.slice(2);
const dist = (path) => pathToFileURL(join(import.meta.dirname, "..", "dist", "esm", path)).href;

export const SIZES = {
  set: 1000,
  get: 10_000,
  getKeys: 1000,
  add: 1000,
  bulk: 5000,
  coldKeys: 10_000,
  allCalls: 20,
};

/** Deterministic PRNG so every library sees the same key sequence. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const value = (i) => ({ id: i, name: `user${i}`, coins: i * 10, tags: ["a", "b"] });

/** Uniform adapter: sync libraries stay sync so they pay no `await` overhead. */
async function open(name) {
  switch (name) {
    case "zula":
    case "zula-normal": {
      const { Zula } = await import(dist("index.js"));
      const db = new Zula(join(dir, "zula.sqlite"), name === "zula-normal" ? { synchronous: "normal" } : {});
      return {
        async: false,
        set: (k, v) => db.set(k, v),
        get: (k) => db.get(k),
        add: (k, n) => db.add(k, n),
        bulk: (n) => db.transaction(() => { for (let i = 0; i < n; i++) db.set(`user_${i}`, value(i)); }),
        all: () => db.all(),
        close: () => db.close(),
      };
    }
    case "zula-quickdb": {
      const { QuickDB } = await import(dist("compat/quickdb.js"));
      const db = new QuickDB({ filePath: join(dir, "json.sqlite") });
      return {
        async: true,
        set: (k, v) => db.set(k, v),
        get: (k) => db.get(k),
        add: (k, n) => db.add(k, n),
        bulk: null,
        all: () => db.all(),
        close: () => db.driver.close(),
      };
    }
    case "quickdb": {
      const { QuickDB } = require("quick.db");
      const db = new QuickDB({ filePath: join(dir, "json.sqlite") });
      await db.init();
      return {
        async: true,
        set: (k, v) => db.set(k, v),
        get: (k) => db.get(k),
        add: (k, n) => db.add(k, n),
        bulk: null,
        all: () => db.all(),
        close: () => db.driver.database.close(),
      };
    }
    case "wiodb": {
      const { JsonDatabase } = require("wio.db");
      // wio.db resolves databasePath against process.cwd(); run.mjs starts us inside `dir`.
      const db = new JsonDatabase({ databasePath: "db.json" });
      return {
        async: false,
        set: (k, v) => db.set(k, v),
        get: (k) => db.get(k),
        add: (k, n) => db.add(k, n),
        bulk: null,
        all: () => db.all(),
        close: () => {},
      };
    }
    default:
      throw new Error(`unknown library ${name}`);
  }
}

async function loop(lib, n, op) {
  const start = performance.now();
  if (lib.async) for (let i = 0; i < n; i++) await op(i);
  else for (let i = 0; i < n; i++) op(i);
  return performance.now() - start;
}

async function main() {
  if (workload === "cold") {
    // Measures from process start (performance.now() is relative to it) to the first read.
    const importStart = performance.now();
    const lib = await open(library);
    const first = lib.get("user_4242");
    if (lib.async) await first;
    const end = performance.now();
    lib.close();
    return { processToFirstGetMs: end, libraryToFirstGetMs: end - importStart };
  }
  const lib = await open(library);
  let result;
  switch (workload) {
    case "set": {
      const ms = await loop(lib, SIZES.set, (i) => lib.set(`user_${i}`, value(i)));
      result = { ops: SIZES.set, ms };
      break;
    }
    case "get": {
      for (let i = 0; i < SIZES.getKeys; i++) {
        const r = lib.set(`user_${i}`, value(i));
        if (lib.async) await r;
      }
      const rand = mulberry32(42);
      const ms = await loop(lib, SIZES.get, () => lib.get(`user_${Math.floor(rand() * SIZES.getKeys)}`));
      result = { ops: SIZES.get, ms };
      break;
    }
    case "add": {
      const ms = await loop(lib, SIZES.add, () => lib.add("counter", 1));
      const final = lib.async ? await lib.get("counter") : lib.get("counter");
      if (final !== SIZES.add) throw new Error(`counter is ${final}, expected ${SIZES.add}`);
      result = { ops: SIZES.add, ms };
      break;
    }
    case "bulk-loop": {
      const ms = await loop(lib, SIZES.bulk, (i) => lib.set(`user_${i}`, value(i)));
      result = { ops: SIZES.bulk, ms };
      break;
    }
    case "all": {
      // Runs on a copy of the cold-start template (SIZES.coldKeys entries).
      const ms = await loop(lib, SIZES.allCalls, () => lib.all());
      result = { ops: SIZES.allCalls, ms };
      break;
    }
    case "bulk-tx": {
      if (lib.bulk === null) throw new Error(`${library} has no transaction API`);
      const start = performance.now();
      lib.bulk(SIZES.bulk);
      result = { ops: SIZES.bulk, ms: performance.now() - start };
      break;
    }
    default:
      throw new Error(`unknown workload ${workload}`);
  }
  lib.close();
  return result;
}

if (library !== undefined) {
  process.stdout.write(JSON.stringify(await main()));
}
