// Convert quick.db storage to the native Depo API, not the async compatibility
// API. Stop writers first and keep the original source as your rollback copy.
// Run: node examples/migrate-quickdb.mjs json.sqlite bot.sqlite
import { Depo } from "depo.db";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function migrateQuickDb(source, target) {
  // package.json is a public export. Resolve its advertised bin instead of
  // importing an unpublished internal migrate.js or assuming a dist layout.
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("depo.db/package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const cli = resolve(dirname(packagePath), manifest.bin.depo);
  const child = spawnSync(process.execPath, [
    cli, "migrate", source, "--from", "quickdb", "--to", target, "--json",
  ], { encoding: "utf8" });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr.trim() || `depo migrate exited with ${child.status}`);
  const report = JSON.parse(child.stdout);
  const db = new Depo(target);
  try {
    // quick.db's "json" table maps to "default"; other tables retain their
    // names as absolute namespaces. Dotted top-level keys remain literal keys.
    const namespaces = report.groups.map(({ namespace }) => ({
      namespace,
      sample: db.table(namespace).all({ limit: 5 }),
    }));
    return { report, namespaces };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [source, target, ...extra] = process.argv.slice(2);
    if (!source || !target || extra.length > 0) {
      throw new Error("Usage: node examples/migrate-quickdb.mjs <quickdb-source.sqlite> <depo-target.sqlite>");
    }
    console.log(JSON.stringify(migrateQuickDb(source, target), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
