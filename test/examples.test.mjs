import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Depo } from "depo.db";
import { createCommandHandler, transferCoins } from "../examples/discord-commands.mjs";
import { FIXTURES, ROOT, onCleanup, tempDir } from "./helpers.mjs";

function open(t) {
  const db = new Depo(join(tempDir(t), "bot.sqlite"));
  onCleanup(t, () => db.close());
  return db;
}

function message(content, overrides = {}) {
  const replies = [];
  return {
    guildId: "100", author: { id: "111" }, content,
    reply: async (text) => { replies.push(text); },
    ...overrides, replies,
  };
}

function demo(name, args, cwd) {
  return spawnSync(process.execPath, [join(ROOT, "examples", name), ...args], {
    encoding: "utf8", cwd, timeout: 30_000,
  });
}

function successfulDemo(name, args, cwd) {
  const result = demo(name, args, cwd);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("command example isolates settings and ignores DMs, bots and unknown commands", async (t) => {
  const db = open(t);
  const handle = createCommandHandler(db);
  for (const incoming of [
    message("!daily", { guildId: null }),
    message("!daily", { author: { id: "111", bot: true } }),
    message("ordinary chat"), message("!unknown"),
  ]) {
    assert.deepEqual(await handle(incoming), { status: "ignored" });
    assert.deepEqual(incoming.replies, []);
  }
  const forbidden = message("!prefix $");
  assert.equal((await handle(forbidden)).status, "forbidden");
  assert.match(forbidden.replies[0], /permission required/);
  assert.equal(db.table("guild:100").has("settings.prefix"), false);
  assert.equal((await handle(message("!prefix", { canManageGuild: true }))).status, "usage");
  const changed = await handle(message("!prefix $", { canManageGuild: true }));
  assert.deepEqual(changed, { command: "prefix", status: "prefix-set", prefix: "$" });
  assert.equal((await handle(message("!balance"))).status, "ignored");
  assert.equal((await handle(message("$balance"))).balance, 0);
  assert.equal((await handle(message("!balance", { guildId: "200" }))).balance, 0);
  assert.equal(db.table("guild:100").get("settings.prefix"), "$");
  assert.equal(db.table("guild:200").has("settings.prefix"), false);
  assert.deepEqual(db.all(), [], "the root namespace stays untouched");
});

test("command example transfers atomically, denies overdrafts and rejects invalid amounts", async (t) => {
  const db = open(t);
  const handle = createCommandHandler(db);
  const guild = db.table("guild:100");
  guild.set(["wallet:111"], 100);
  guild.set(["wallet:222"], 10);
  const paid = message("!pay <@222> 40");
  assert.deepEqual(await handle(paid), {
    command: "pay", status: "transferred", amount: 40, balance: 60, recipientBalance: 50,
  });
  assert.match(paid.replies[0], /Transferred 40 coins/);
  assert.equal((await handle(message("!pay <@!222> 10"))).balance, 50);
  const denied = message("!pay 222 51");
  assert.equal((await handle(denied)).status, "insufficient-funds");
  assert.match(denied.replies[0], /no coins moved/);
  for (const command of [
    "!pay 222 0", "!pay 222 -1", "!pay 222 1.5", "!pay 222 1e2",
    "!pay 222 9007199254740992", "!pay 111 1", "!pay nobody 1", "!pay 222 1 extra",
  ]) {
    assert.ok(["invalid-transfer", "usage"].includes((await handle(message(command))).status), command);
  }
  assert.equal((await handle(message("!pay 111 1", { author: { id: "333" } }))).status, "insufficient-funds");
  assert.equal(guild.get(["wallet:111"]), 50);
  assert.equal(guild.get(["wallet:222"]), 60);
  assert.equal(guild.has(["wallet:333"]), false);
  assert.equal((await handle(message("!balance", { guildId: "200" }))).balance, 0);
  assert.equal((await handle(message("!pay 222 1", { guildId: "200" }))).status, "insufficient-funds");
  assert.throws(() => db.transaction(() => {
    assert.equal(transferCoins(guild, "111", "222", 20).status, "transferred");
    throw new Error("cancel transaction");
  }), /cancel transaction/);
  assert.equal(guild.get(["wallet:111"]), 50, "the debit rolls back");
  assert.equal(guild.get(["wallet:222"]), 60, "the credit rolls back too");
  guild.set(["wallet:222"], Number.MAX_SAFE_INTEGER);
  assert.equal((await handle(message("!pay 222 1"))).status, "balance-limit");
  assert.equal(guild.get(["wallet:111"]), 50);
  assert.equal(guild.get(["wallet:222"]), Number.MAX_SAFE_INTEGER);
});

test("command example daily cooldowns are persistent and scoped by guild and member", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const db = open(t);
  const handle = createCommandHandler(db);
  assert.equal((await handle(message("!daily"))).balance, 100);
  const denied = message("!daily");
  assert.deepEqual(await handle(denied), { command: "daily", status: "cooldown", retryAfter: 86_400_000 });
  assert.match(denied.replies[0], /Daily cooldown/);
  assert.equal((await handle(message("!daily", { guildId: "200" }))).balance, 100);
  assert.equal((await handle(message("!daily", { author: { id: "222" } }))).balance, 100);
  const file = db.path;
  db.close();
  const reopened = new Depo(file);
  onCleanup(t, () => reopened.close());
  const handleAgain = createCommandHandler(reopened);
  now += 86_399_999;
  assert.equal((await handleAgain(message("!daily"))).retryAfter, 1);
  now += 1;
  assert.equal((await handleAgain(message("!daily"))).balance, 200);
  assert.equal(reopened.table("guild:200").get(["wallet:111"]), 100);
  assert.equal(reopened.table("guild:100").get(["wallet:222"]), 100);
});

test("command example XP leaderboard and cooldowns use real scoped database state", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const db = open(t);
  const handle = createCommandHandler(db);
  assert.deepEqual((await handle(message("!leaderboard"))).entries, []);
  assert.equal((await handle(message("!xp"))).score, 15);
  assert.equal((await handle(message("!xp"))).retryAfter, 60_000);
  assert.equal((await handle(message("!xp", { author: { id: "222" } }))).score, 15);
  assert.deepEqual((await handle(message("!leaderboard"))).entries, [
    { member: "111", score: 15, rank: 1 }, { member: "222", score: 15, rank: 2 },
  ]);
  assert.equal((await handle(message("!xp", { guildId: "200" }))).score, 15);
  now += 59_999;
  assert.equal((await handle(message("!xp", { author: { id: "222" } }))).retryAfter, 1);
  now += 1;
  assert.equal((await handle(message("!xp", { author: { id: "222" } }))).score, 30);
  const ranked = message("!leaderboard");
  assert.deepEqual((await handle(ranked)).entries, [
    { member: "222", score: 30, rank: 1 }, { member: "111", score: 15, rank: 2 },
  ]);
  assert.match(ranked.replies[0], /^1\. <@222> — 30 XP/);
  assert.deepEqual((await handle(message("!leaderboard", { guildId: "200" }))).entries, [
    { member: "111", score: 15, rank: 1 },
  ]);
  assert.equal((await handle(message("!daily"))).status, "claimed", "XP cooldown does not consume daily capacity");
});

test("command demo runs from another cwd with default memory and an explicit file", (t) => {
  const cwd = tempDir(t);
  for (const args of [[], [join(cwd, "demo with spaces.sqlite")]]) {
    const stdout = successfulDemo("discord-commands.mjs", args, cwd);
    assert.match(stdout, /Daily reward: 100 coins/);
    assert.match(stdout, /Daily cooldown/);
    assert.match(stdout, /Transferred 25 coins/);
    assert.match(stdout, /Insufficient funds; no coins moved/);
    assert.match(stdout, /XP cooldown/);
    assert.match(stdout, /1\. <@111> — 15 XP/);
    assert.match(stdout, /Prefix changed to \$/);
    assert.match(stdout, /\[guild 200, user 111\] Balance: 0 coins/);
  }
  const db = new Depo(join(cwd, "demo with spaces.sqlite"));
  onCleanup(t, () => db.close());
  assert.equal(db.table("guild:100").get(["wallet:111"]), 75);
  assert.equal(db.table("guild:100").get(["wallet:222"]), 25);
  assert.equal(db.table("guild:100").get("settings.prefix"), "$");
  assert.equal(db.table("guild:100").leaderboard("xp").score("111"), 15);
});

test("quick.db migration demo invokes the package CLI and preserves source bytes", (t) => {
  const cwd = tempDir(t);
  const source = join(cwd, "original quickdb.sqlite");
  const target = join(cwd, "native depo.sqlite");
  copyFileSync(join(FIXTURES, "quickdb", "json.sqlite"), source);
  const original = readFileSync(source);
  // This committed fixture was produced by real quick.db 9 + better-sqlite3.
  const raw = new DatabaseSync(source, { readOnly: true });
  let expected;
  try {
    expected = ["json", "economy"].map((table) => ({
      namespace: table === "json" ? "default" : table,
      entries: raw.prepare(`SELECT ID, json FROM "${table}" ORDER BY ID`).all()
        .map(({ ID, json }) => ({ key: ID, value: JSON.parse(json) })),
    }));
  } finally {
    raw.close();
  }
  const result = JSON.parse(successfulDemo("migrate-quickdb.mjs", [source, target], cwd));
  const count = expected.reduce((sum, group) => sum + group.entries.length, 0);
  assert.equal(result.report.format, "quickdb");
  assert.deepEqual(result.report.total, { read: count, inserted: count, updated: 0, unchanged: 0, conflicts: 0 });
  assert.deepEqual(result.namespaces.map(({ namespace }) => namespace).sort(), ["default", "economy"]);
  assert.deepEqual(readFileSync(source), original, "the original SQLite file is byte-for-byte unchanged");
  const db = new Depo(target);
  try {
    for (const { namespace, entries } of expected) assert.deepEqual(db.table(namespace).all(), entries);
    assert.equal(db.get(["dotted.key"]), "literal", "a dotted legacy key is not treated as a path");
    assert.equal(db.table("economy").get("bank_111"), 900);
  } finally {
    db.close();
  }
  const again = JSON.parse(successfulDemo("migrate-quickdb.mjs", [source, target], cwd));
  assert.deepEqual(again.report.total, { read: count, inserted: 0, updated: 0, unchanged: count, conflicts: 0 });
  const changed = new Depo(target);
  changed.set("money_111", 1);
  changed.close();
  const conflict = JSON.parse(successfulDemo("migrate-quickdb.mjs", [source, target], cwd));
  assert.equal(conflict.report.total.conflicts, 1);
  const check = new Depo(target);
  try {
    assert.equal(check.get("money_111"), 1, "the example never opts into overwriting conflicting target data");
  } finally {
    check.close();
  }
  assert.deepEqual(readFileSync(source), original, "repeated migration and conflicts never rewrite the source");
});

test("runnable examples report argument and migration errors as nonzero exits", (t) => {
  const cwd = tempDir(t);
  for (const [name, args] of [
    ["discord-commands.mjs", ["a", "b"]],
    ["migrate-quickdb.mjs", []],
    ["migrate-quickdb.mjs", [join(cwd, "missing.sqlite"), join(cwd, "target.sqlite")]],
  ]) {
    const result = demo(name, args, cwd);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|Source file not found/);
  }
});
