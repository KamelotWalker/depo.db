// No Discord client is created. Pass a shared Depo and message-like objects from
// your own adapter. Run: node examples/discord-commands.mjs [bot.sqlite]
import { Depo } from "depo.db";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DAILY = { limit: 1, window: 86_400_000 };
const XP = { limit: 1, window: 60_000 };
const walletKey = (userId) => [`wallet:${userId}`];
const isId = (value) => typeof value === "string" && /^\d+$/.test(value);

function balance(guild, userId) {
  const coins = guild.get(walletKey(userId), 0);
  if (!Number.isSafeInteger(coins) || coins < 0) {
    throw new Error(`Invalid stored balance for ${userId}`);
  }
  return coins;
}

// Keep the read, overdraft check and BOTH writes inside the same synchronous
// transaction. Replies (and any other async work) belong outside it.
export function transferCoins(guild, senderId, recipientId, amount) {
  if (!isId(senderId) || !isId(recipientId) || senderId === recipientId ||
      !Number.isSafeInteger(amount) || amount <= 0) {
    return { status: "invalid-transfer" };
  }
  return guild.transaction(() => {
    const sender = balance(guild, senderId);
    const recipient = balance(guild, recipientId);
    if (sender < amount) return { status: "insufficient-funds", balance: sender };
    if (!Number.isSafeInteger(recipient + amount)) return { status: "balance-limit" };
    guild.set(walletKey(senderId), sender - amount);
    guild.set(walletKey(recipientId), recipient + amount);
    return { status: "transferred", amount, balance: sender - amount, recipientBalance: recipient + amount };
  });
}

/**
 * Message shape: { guildId, author: { id, bot? }, content, reply(text),
 *                  canManageGuild?: boolean }.
 * The adapter MUST derive canManageGuild from trusted server permissions, not
 * message content. Snowflakes remain strings. DMs/bots/unknown commands are ignored.
 * This function never closes the injected connection.
 */
export function createCommandHandler(db) {
  return async function handleMessage(message) {
    if (!isId(message.guildId) || !isId(message.author?.id) || message.author.bot ||
        typeof message.content !== "string") return { status: "ignored" };
    // table() selects an absolute namespace; it does not nest under a view.
    const guild = db.table(`guild:${message.guildId}`);
    const prefix = guild.get("settings.prefix", "!");
    if (!message.content.startsWith(prefix)) return { status: "ignored" };
    const [command, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
    const userId = message.author.id;
    const reply = async (result, text) => {
      await message.reply(text);
      return { command, ...result };
    };
    switch (command) {
      case "prefix": {
        if (message.canManageGuild !== true) return reply({ status: "forbidden" }, "Manage Server permission required.");
        if (args.length !== 1 || args[0].length > 8) {
          return reply({ status: "usage" }, `Usage: ${prefix}prefix <1-8 non-whitespace characters>`);
        }
        guild.set("settings.prefix", args[0]);
        return reply({ status: "prefix-set", prefix: args[0] }, `Prefix changed to ${args[0]}`);
      }
      case "balance": {
        const coins = balance(guild, userId);
        return reply({ status: "balance", balance: coins }, `Balance: ${coins} coins.`);
      }
      case "pay": {
        // Accept a raw user ID or a Discord-style mention. Never coerce an ID to Number.
        const recipientId = /^(?:<@!?(\d+)>|(\d+))$/.exec(args[0] ?? "");
        const amount = /^\d+$/.test(args[1] ?? "") ? Number(args[1]) : NaN;
        if (args.length !== 2 || recipientId === null) {
          return reply({ status: "usage" }, `Usage: ${prefix}pay <user-id or mention> <positive whole coins>`);
        }
        const result = transferCoins(guild, userId, recipientId[1] ?? recipientId[2], amount);
        const text = result.status === "transferred"
          ? `Transferred ${amount} coins. Balance: ${result.balance}.`
          : result.status === "insufficient-funds" ? "Insufficient funds; no coins moved."
          : result.status === "balance-limit" ? "Recipient balance limit reached; no coins moved."
          : "Use a positive safe-integer amount and a different recipient.";
        return reply(result, text);
      }
      case "daily": {
        // A denied claim and its balance update share one transaction. A failure
        // rolls back the consumed use too; no asynchronous callback is involved.
        const result = guild.transaction(() => {
          const coins = balance(guild, userId);
          if (!Number.isSafeInteger(coins + 100)) return { status: "balance-limit" };
          const cooldown = guild.rateLimit(`daily:${userId}`, DAILY);
          if (!cooldown.allowed) return { status: "cooldown", retryAfter: cooldown.retryAfter };
          guild.set(walletKey(userId), coins + 100);
          return { status: "claimed", balance: coins + 100 };
        });
        return reply(result, result.status === "claimed" ? `Daily reward: 100 coins. Balance: ${result.balance}.`
          : result.status === "cooldown" ? `Daily cooldown: retry in ${result.retryAfter} ms.`
          : "Balance limit reached; no reward claimed.");
      }
      case "xp": {
        const result = guild.transaction(() => {
          const cooldown = guild.rateLimit(`xp:${userId}`, XP);
          if (!cooldown.allowed) return { status: "cooldown", retryAfter: cooldown.retryAfter };
          return { status: "xp-awarded", score: guild.leaderboard("xp").add(userId, 15) };
        });
        return reply(result, result.status === "xp-awarded" ? `XP: ${result.score}.`
          : `XP cooldown: retry in ${result.retryAfter} ms.`);
      }
      case "leaderboard": {
        const entries = guild.leaderboard("xp").top(10);
        return reply({ status: "leaderboard", entries }, entries.length === 0 ? "No XP yet."
          : entries.map(({ member, score, rank }) => `${rank}. <@${member}> — ${score} XP`).join("\n"));
      }
      default:
        return { status: "ignored" };
    }
  };
}

export async function runDemo(databasePath = ":memory:") {
  const db = new Depo(databasePath);
  try {
    const handle = createCommandHandler(db);
    const send = (guildId, userId, content, canManageGuild = false) => handle({
      guildId, author: { id: userId }, content, canManageGuild,
      reply: (text) => console.log(`[guild ${guildId}, user ${userId}] ${text}`),
    });
    // These are local message objects, not a bot connection. Stored demo state
    // is intentionally retained on subsequent runs with the same database file.
    const prefix = db.table("guild:100").get("settings.prefix", "!");
    await send("100", "111", `${prefix}daily`);
    await send("100", "111", `${prefix}daily`);
    await send("100", "111", `${prefix}pay <@222> 25`);
    await send("100", "111", `${prefix}pay 222 9007199254740991`);
    await send("100", "222", `${prefix}balance`);
    await send("100", "111", `${prefix}xp`);
    await send("100", "111", `${prefix}xp`);
    await send("100", "222", `${prefix}xp`);
    await send("100", "111", `${prefix}leaderboard`);
    await send("100", "111", `${prefix}prefix $`, true);
    await send("100", "111", "$balance");
    const otherPrefix = db.table("guild:200").get("settings.prefix", "!");
    await send("200", "111", `${otherPrefix}balance`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error("Usage: node examples/discord-commands.mjs [bot.sqlite]");
    await runDemo(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
