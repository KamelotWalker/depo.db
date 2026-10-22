import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const FIXTURES = join(ROOT, "test", "fixtures");
export const CLI = join(ROOT, "dist", "cjs", "cli.js");

const TMP_ROOT = join(ROOT, ".tmp");
const cleanups = new WeakMap();

/**
 * Registers `fn` to run when the test ends, before its temp directories are
 * removed (open SQLite files cannot be deleted on Windows). Runs in LIFO order.
 */
export function onCleanup(t, fn) {
  let list = cleanups.get(t);
  if (list === undefined) {
    list = [];
    cleanups.set(t, list);
    t.after(() => {
      for (const cleanup of list.reverse()) cleanup();
    });
  }
  list.push(fn);
}

/** Creates a fresh directory under <repo>/.tmp, removed when the test ends. */
export function tempDir(t) {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, "t-"));
  onCleanup(t, () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
