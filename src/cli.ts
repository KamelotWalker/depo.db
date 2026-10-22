#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DepoError } from "./errors.js";
import { runMigration, type MigrationReport, type SourceFormat } from "./migrate.js";
import { VERSION } from "./version.js";

const USAGE = `Usage: depo migrate <source> [options]

Imports a wio.db or croxydb JSON file, or a quick.db SQLite file, into a Depo
SQLite file. Safe to run repeatedly: entries already present with the same
value are counted as unchanged.

Options:
  --from <format>     wio | croxydb | quickdb. Default: quickdb for SQLite files,
                      wio for anything else. Use croxydb to carry over TTLs from
                      the <name>.ttl.json sidecar.
  --to <file>         Target Depo file. Default: depo.sqlite
  --namespace <name>  Target namespace for JSON sources. Default: default
  --table <name>      quick.db table to import; repeatable. Default: all tables.
                      Table "json" goes to namespace "default", any other table
                      to the namespace with the same name.
  --overwrite         Replace target entries whose value differs. Default: keep
                      them and report them as conflicts.
  --dry-run           Report what would change without writing anything.
  --json              Print the report as JSON.
  -h, --help          Show this help.
  -v, --version       Show the version.`;

const FORMATS: readonly SourceFormat[] = ["wio", "croxydb", "quickdb"];

function isFormat(value: string): value is SourceFormat {
  return FORMATS.some((format) => format === value);
}

function formatReport(report: MigrationReport): string {
  const lines = [
    `${report.dryRun ? "Dry run: " : ""}${report.source} (${report.format}) -> ${report.target}`,
  ];
  for (const group of report.groups) {
    lines.push(
      `  ${group.origin} -> namespace "${group.namespace}": read ${group.read}, inserted ${group.inserted}, ` +
        `updated ${group.updated}, unchanged ${group.unchanged}, conflicts ${group.conflicts}`,
    );
    for (const warning of group.warnings) lines.push(`    warning: ${warning}`);
  }
  const t = report.total;
  lines.push(
    `Total: read ${t.read}, inserted ${t.inserted}, updated ${t.updated}, unchanged ${t.unchanged}, conflicts ${t.conflicts}`,
  );
  if (t.conflicts > 0) {
    lines.push("Conflicting entries were kept as they are in the target. Re-run with --overwrite to replace them.");
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      namespace: { type: "string" },
      table: { type: "string", multiple: true },
      overwrite: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const [command, source, ...extra] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (command !== "migrate") throw new DepoError(`Unknown command ${JSON.stringify(command)}. Run depo --help.`);
  if (source === undefined) throw new DepoError("Missing <source> file. Run depo --help.");
  if (extra.length > 0) throw new DepoError(`Unexpected arguments: ${extra.join(" ")}`);
  if (values.from !== undefined && !isFormat(values.from)) {
    throw new DepoError(`--from must be one of ${FORMATS.join(", ")}`);
  }

  const report = runMigration({
    source,
    ...(values.from !== undefined && { format: values.from }),
    ...(values.to !== undefined && { target: values.to }),
    ...(values.namespace !== undefined && { namespace: values.namespace }),
    ...(values.table !== undefined && { tables: values.table }),
    overwrite: values.overwrite,
    dryRun: values["dry-run"],
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // DepoError and Node system/argument errors (they carry a `code`) are user-facing; anything else is a bug.
  const expected = error instanceof Error && (error instanceof DepoError || "code" in error);
  console.error(`depo: ${error instanceof Error ? error.message : String(error)}`);
  if (!expected && error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
}
