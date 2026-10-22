// Generates migration fixtures with the real wio.db, quick.db (+ better-sqlite3)
// and croxydb packages (devDependencies). The output is committed under
// test/fixtures/ so tests do not depend on these packages at runtime.
//
//   npm run fixtures
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "test", "fixtures");
process.chdir(root);

// --- wio.db 4.0.22 -----------------------------------------------------------
rmSync(join(fixtures, "wio"), { recursive: true, force: true });
{
  const { JsonDatabase } = require("wio.db");
  // wio.db resolves databasePath against process.cwd() and only creates
  // directories when the path uses the platform separator.
  const db = new JsonDatabase({ databasePath: join("test", "fixtures", "wio", "db.json") });
  db.set("money_111", 500);
  db.add("money_111", 250);
  db.set("money_222", 0);
  // Discord snowflakes exceed Number.MAX_SAFE_INTEGER, so lodash treats them as object keys.
  db.set("user.312345678901234567.name", "Ayşe");
  db.set("user.312345678901234567.level", 7);
  db.set("user.398765432109876543.name", "Mehmet");
  db.push("inventory_111", "kılıç");
  db.push("inventory_111", "kalkan");
  db.set("guild.876543210987654321.prefix", "!");
  db.set("guild.876543210987654321.channels", ["genel", "duyuru"]);
  // A small numeric segment makes lodash create an array: { slots: [null, null, "x"] }.
  db.set("slots.2", "x");
  db.set("flag", true);
  db.set("text", "merhaba dünya");
  db.set("emoji_🎉", "parti");
  db.set("float", 3.25);
  db.set("nested", { a: { b: { c: [1, { d: null }] } } });
}

// --- quick.db 9.1.7 + better-sqlite3 ---------------------------------------
rmSync(join(fixtures, "quickdb"), { recursive: true, force: true });
mkdirSync(join(fixtures, "quickdb"), { recursive: true });
{
  const { QuickDB } = require("quick.db");
  const filePath = join(fixtures, "quickdb", "json.sqlite");
  const db = new QuickDB({ filePath });
  await db.init();
  await db.set("money_111", 500);
  await db.add("money_111", 250);
  await db.set("user_111", { name: "Ayşe", level: 7 });
  await db.set("user_111.level", 8);
  await db.push("inventory_111", "kılıç", "kalkan");
  await db.set("text", "merhaba dünya");
  await db.set("flag", false);
  await db.set("nested", { a: { b: { c: [1, { d: null }] } } });
  const economy = db.table("economy");
  await economy.init();
  await economy.set("bank_111", 1000);
  await economy.sub("bank_111", 100);
  await economy.set("bank_222", 50);
  // A literal dotted key, only reachable with normalKeys.
  const literal = new QuickDB({ filePath, normalKeys: true });
  await literal.init();
  await literal.set("dotted.key", "literal");
  db.driver.database.close();
  economy.driver.database.close();
  literal.driver.database.close();
}

// --- croxydb 0.0.27 (jsondb adapter) ----------------------------------------
rmSync(join(fixtures, "croxydb"), { recursive: true, force: true });
{
  const croxy = require("croxydb");
  const db = croxy.createInstance({ folder: "test/fixtures/croxydb", file: "croxydb", checkUpdates: false });
  db.set("money_111", 500);
  db.add("money_111", 250);
  db.set("user.312345678901234567.name", "Ayşe");
  db.push("inventory_111", "kılıç");
  db.push("inventory_111", "kalkan");
  db.set("text", "merhaba dünya");
  // TTL far in the future on a top-level key: carried over by the migrator.
  db.set("session_111", { token: "abc" }, { ttl: new Date("2099-01-01T00:00:00Z") });
  // TTL on a nested key: croxydb tracks it by full path; Depo cannot express it.
  db.set("cooldown.312345678901234567", true, { ttl: new Date("2099-01-01T00:00:00Z") });
}

console.log("Fixtures written to", fixtures);
