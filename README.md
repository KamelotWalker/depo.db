# Depo

**English** | [Türkçe](https://github.com/KamelotWalker/depo.db/blob/main/docs/README.tr.md)

depo.db is a zero-dependency key-value database for Node.js built on the built-in
`node:sqlite` — a drop-in replacement for quick.db and wio.db with no native
modules or node-gyp. Use it for Discord bots and small backends that need local,
persistent JSON data without running a database server.

The native `Depo` API is synchronous. The `depo.db/quickdb` entry point preserves
quick.db v9's async API and SQLite format; `depo.db/wiodb` preserves wio.db v4's
`JsonDatabase` API and imports its JSON file once. See the documented
[quick.db](docs/compat-quickdb.md) and [wio.db](docs/compat-wiodb.md) compatibility
differences before switching.

- Synchronous API: `get`, `set`, `has`, `delete`, `all`, `add`, `subtract`, `push`, `pull`
- Dot paths into stored objects: `db.add("user.42.coins", 10)`
- TTL per entry, namespaces, multi-key transactions
- Indexed leaderboards for XP/economy rankings and smooth-refill command rate limits
- Bounded keyset pagination and key-only reads without decoding JSON values
- Atomic across processes: several bot shards can share one file
- `depo migrate` CLI to import wio.db, croxydb and quick.db data

## Install

```sh
npm install depo.db
```

Requires **Node.js 24.15.0 or newer**: the first release line where
`node:sqlite` needs no flag and no longer prints an `ExperimentalWarning`
([details](docs/decisions.md#13-minimum-nodejs-version-24150)).

## Quick start

```js
const { Depo } = require("depo.db");     // or: import { Depo } from "depo.db";

const db = new Depo("bot.sqlite");    // created if missing; parent folder must exist

db.set("prefix", "!");
db.get("prefix");                     // "!"

db.add("user.312345678901234567.coins", 50);   // 50
db.get("user.312345678901234567");             // { coins: 50 }

db.push("inventory.312345678901234567", "kılıç", "kalkan");
db.pull("inventory.312345678901234567", "kılıç");  // ["kalkan"]

db.set("cooldown:daily:312345678901234567", true, { ttl: 24 * 60 * 60 * 1000 });

const economy = db.table("economy");  // separate namespace, same file
economy.set("bank", 1000);

db.transaction(() => {                // all or nothing
  economy.subtract("bank", 100);
  db.add("user.312345678901234567.coins", 100);
});
```

## Runnable examples

After installing dependencies and running `npm run build` in a source checkout:

```sh
node examples/discord-commands.mjs              # local demo, in-memory database
node examples/discord-commands.mjs bot.sqlite   # retain demo data between runs
node examples/migrate-quickdb.mjs json.sqlite bot.sqlite
```

- [Discord-style command handler](examples/discord-commands.mjs): injectable
  message adapter, per-guild prefixes, atomic economy transfers without
  overdrafts, XP rankings and persistent cooldowns. No Discord client, token,
  network connection or `discord.js` dependency. Your adapter supplies trusted
  permissions and `reply()`; it owns connection shutdown.
- [quick.db migration](examples/migrate-quickdb.mjs): runs the real supported
  migration CLI, then reads native namespace samples. Stop source writers first
  and choose a separate target; the original remains your rollback copy.

The daily reward uses a rolling 24-hour cooldown, not a calendar-midnight reset;
XP can be awarded once per minute. Keep Discord IDs as strings.
Both executable examples are exercised by `npm test` and included in the npm
package under `node_modules/depo.db/examples/`.

## Why depo.db? Frequently asked questions

### What is a quick.db alternative without better-sqlite3?

Use `depo.db/quickdb` to keep quick.db v9's async API and existing `json.sqlite`
file without `better-sqlite3`. Only Depo's SQLite and memory drivers are supported;
see [compatibility differences](docs/compat-quickdb.md).

```js
import { QuickDB } from "depo.db/quickdb";
const db = new QuickDB();
await db.set("prefix", "!");
await db.get("prefix"); // "!"
```

### Can depo.db replace quick.db when installation fails with a node-gyp error?

Yes, if you can use **Node.js 24.15.0 or newer**. Depo uses Node's built-in
SQLite rather than compiling a native npm addon. For a new project, use the
synchronous native API; for an existing quick.db bot, use the entry point above.

```js
const { Depo } = require("depo.db");
const db = new Depo("bot.sqlite");
db.set("prefix", "!");
db.close();
```

### Is depo.db a wio.db replacement, and how do I migrate?

Replace the import with `depo.db/wiodb` and keep your `JsonDatabase` code.
On first open, the existing `databases/db.json` is imported into
`databases/db.sqlite`; the JSON source is left untouched. This layer does not
provide `YamlDatabase`; see [compatibility differences](docs/compat-wiodb.md).

```js
const { JsonDatabase } = require("depo.db/wiodb");
const db = new JsonDatabase();
db.set("prefix", "!");
db.get("prefix"); // "!"
```

### What is a simple database for a discord.js bot?

Use `Depo` for bot settings, coins, XP leaderboards and command rate limits.
Open one connection at startup and reuse it in your command handlers; discord.js
is not a dependency of Depo. For example, store and read a command prefix:

```js
const { Depo } = require("depo.db");
const db = new Depo("bot.sqlite");
db.set("prefix", "!");
db.get("prefix"); // "!"
```

### How do I use a key-value store with Node.js and SQLite?

Use the native synchronous API for JSON values, dot paths, TTLs, namespaces and
transactions. The SQLite file is created if missing; its parent directory must
already exist. For data conversion rather than API compatibility, use
[`depo migrate`](#depo-migrate-move-data-to-the-native-api).

```js
import { Depo } from "depo.db";
const db = new Depo("bot.sqlite");
db.set("cooldown:daily:312345678901234567", true, { ttl: 60_000 });
db.get("cooldown:daily:312345678901234567"); // true until expiry
db.close();
```

Depo is not a distributed database or a pub/sub system. Processes sharing one
file must run on the same machine; synchronous disk operations block the event
loop. See [limitations](#limitations) before choosing it for a write-heavy service.

## API

`new Depo(path = "depo.sqlite", options?)`

| Option | Default | |
|---|---|---|
| `namespace` | `"default"` | Namespace this instance uses |
| `synchronous` | `"full"` | `"full"` or `"normal"`, see [Durability](#durability-and-concurrency) |
| `busyTimeout` | `5000` | ms to wait for another process's write lock |

| Method | Returns | |
|---|---|---|
| `get(key, default?)` | value \| `default` \| `undefined` | Missing or expired → `default` |
| `set(key, value, { ttl? })` | `value` | `ttl` in ms, whole entries only |
| `has(key)` | `boolean` | A stored `null` counts |
| `delete(key)` | `boolean` | Whether something was removed |
| `all({ prefix?, limit?, after? })` | `{ key, value }[]` | Ordered by key; `after` is exclusive |
| `keys({ prefix?, limit?, after? })` | `string[]` | Same ordering/filters, without loading JSON values |
| `count()` | `number` | Live entries in this namespace |
| `deleteAll()` | `number` | Entries removed from this namespace; leaves leaderboards and rate limits alone |
| `add(key, n)` / `subtract(key, n)` | `number` | Missing counts as 0 |
| `push(key, ...values)` | array | Missing counts as `[]` |
| `pull(key, valueOrPredicate)` | array | Removes every deep-equal element, or where `predicate(el, index)` is true |
| `ttl(key)` | ms \| `null` \| `undefined` | Remaining TTL; `null` = never expires; `undefined` = missing |
| `expire(key, ms \| null)` | `boolean` | Set or clear the TTL of an existing entry |
| `purgeExpired()` | `number` | Delete expired entries and fully refilled rate-limit rows (all namespaces); total rows removed |
| `table(name)` | `Depo` | View of another namespace sharing the connection |
| `leaderboard(name)` | `Leaderboard` | Sorted set scoped to this namespace |
| `rateLimit(key, { limit, window })` | `RateLimitResult` | Atomically consume one use; `window` in ms |
| `resetRateLimit(key)` | `boolean` | Whether rate-limit state was removed |
| `transaction(fn)` | `fn`'s result | Synchronous `fn`, all writes commit together |
| `backup(target)` | `Promise<void>` | Online whole-file backup to a **new** path; await before closing |
| `close()` | | Closes the connection (and all `table()` views) |

Also exported: `Leaderboard`, `DepoError` (thrown for invalid keys, values and type
mismatches), `escapeKey(segment)`, `VERSION`, and the TypeScript types `Key`,
`Entry`, `DepoOptions`, `SetOptions`, `AllOptions`, `LeaderboardEntry`,
`RateLimitOptions`, `RateLimitResult`.

Typed reads: `db.get<number>("coins")` returns `number | undefined`;
`db.get("coins", 0)` returns `number`.

## Keys

A key is a string of segments separated by dots, or an array of segments.

```js
db.set("user.42.name", "Ayşe");       // entry "user" → { "42": { name: "Ayşe" } }
db.get(["user", "42", "name"]);       // same thing, no escaping needed
db.set("site\\.com.visits", 1);       // entry "site.com" → { visits: 1 }
db.get(`${escapeKey("site.com")}.visits`);
```

- The **first segment is the entry**, stored as one SQLite row. The rest is a
  path inside that entry's JSON value.
- `\.` is a literal dot, `\\` a literal backslash. Other escapes, and empty
  segments (`""`, `"a..b"`, `".a"`), throw `DepoError`.
- Missing objects along a path are created as plain objects, also for numeric
  segments: `set("slots.2", "x")` → `{ slots: { "2": "x" } }` (quick.db and
  wio.db would create `[null, null, "x"]`).
- Numeric segments index **existing** arrays: `get("list.0")`,
  `set("list.3", x)` (index ≤ length), `delete("list.0")` splices.
- Writing a path through a non-object (`set("coins.x", 1)` when `coins` is `5`)
  throws instead of replacing the value.
- Entry keys (the first segment) and namespaces must be well-formed Unicode. A
  lone UTF-16 surrogate such as `"a\uD800"` throws `DepoError`: SQLite stores
  text as UTF-8, where it would become U+FFFD and merge with other keys.

Rationale: [decisions §3–4](docs/decisions.md#3-keys-dots-are-paths-backslash-escapes).

## Values

Values are stored as JSON: objects, arrays, strings, numbers, booleans, `null`.

- `undefined`, functions, symbols and `BigInt` throw `DepoError` (use `delete()`
  instead of storing `undefined`), also as the value of a path `set` or `push`.
  Nested inside an object or array, functions and symbols follow plain
  `JSON.stringify` rules (properties dropped, array elements `null`).
- `Date` becomes an ISO string; `NaN` and `Infinity` become `null`.
- `get()` returns a fresh copy; changing it does not change the database.
- `add` throws on non-numbers; `push`/`pull` throw on non-arrays.

## Pagination and key-only reads

Process a bounded page at a time instead of loading every user into memory:

```js
let after;
for (;;) {
  const page = db.all({ prefix: "user:", limit: 100, after });
  if (page.length === 0) break;
  for (const { key, value } of page) {
    console.log(key, value);
  }
  after = page.at(-1).key;
}

// Only need names? No JSON values are loaded or parsed.
const firstKeys = db.keys({ prefix: "user:", limit: 100 });
const nextKeys = db.keys({ prefix: "user:", limit: 100, after: firstKeys.at(-1) });
```

`prefix` and `after` are **literal top-level entry keys**, not dot paths: pass
the last returned key unchanged, even if it contains dots or backslashes.
`after` is exclusive and need not exist. Ordering is SQLite BINARY (UTF-8 byte
order), not JavaScript's default sort or locale order. Both methods return live
entries in the current namespace; expired rows do not consume the limit.
Omitting `limit` returns every match; `limit: 0` returns an empty array.
Limits must be non-negative integers; cursors must be well-formed Unicode strings.

Each page sees current data, not a snapshot spanning calls. Deleting/expiring a
cursor does not skip the next key; new keys after it can appear, while inserts
before it are not revisited. For a stable multi-page view, read all pages inside
a synchronous `db.transaction()` (which holds the existing write lock).

## TTL

```js
db.set("session", { token }, { ttl: 60_000 });
db.ttl("session");          // ~60000
db.expire("session", null); // keep forever
```

Expired entries disappear from every read at once. Their rows are deleted when
a file is opened and by `purgeExpired()`; there are no background timers.
Setting a whole entry without `ttl` clears its TTL; path writes, `add`, `push`
and `pull` keep it.

## Leaderboards

Keep XP rankings in a sorted set instead of loading and sorting every user's JSON:

```js
const xp = db.table(`guild:${message.guildId}`).leaderboard("xp");
xp.add(message.author.id, 15); // atomic, even when several shards award XP
const top10 = xp.top(10);
await message.reply(
  top10.map(({ member, score, rank }) => `${rank}. <@${member}> — ${score} XP`).join("\n") +
  `\nYou are #${xp.rank(message.author.id)}!`
);
```

| `Leaderboard` method | Returns | |
|---|---|---|
| `set(member, score)` | `number` | Store and return the score |
| `add(member, delta)` | `number` | Atomic increment; missing starts at 0 |
| `score(member)` | `number \| undefined` | Missing member → `undefined` |
| `rank(member)` | `number \| undefined` | One-based position; highest score is #1 |
| `top(limit = 10, offset = 0)` | `LeaderboardEntry[]` | `{ member, score, rank }`, highest first; ranks include the offset |
| `remove(member)` | `boolean` | Whether a member was removed |
| `count()` | `number` | Members on this board |
| `clear()` | `number` | Members removed from this board |

Ties use ascending member order (SQLite BINARY), so `rank()` and `top()` always
agree. Names and members are non-empty, well-formed strings, not dot paths.
Scores/deltas must be finite numbers; overflow throws `DepoError` without writing.
Limits/offsets must be non-negative integers. Boards belong to their namespace,
participate in `db.transaction()`, and close with their parent connection.
`db.deleteAll()` only deletes key-value entries, not leaderboards or rate limits.

## Rate limits

Allow a burst of **3 uses per 10 seconds**, then refill smoothly at one use every
10/3 seconds. GCRA stores one arrival time per key; denied calls consume nothing.

```js
const result = db.rateLimit(`daily:${message.author.id}`, { limit: 3, window: 10_000 });
if (!result.allowed) {
  await message.reply(`Slow down! Try again in ${result.retryAfter} ms.`);
} else {
  await message.reply(`Command accepted. ${result.remaining} uses left.`);
}
```

`RateLimitResult` is `{ allowed, remaining, retryAfter, resetAfter }`: `remaining`
is the immediately available whole uses after this call, `retryAfter` is 0 when
allowed, and `resetAfter` is the time until full capacity is restored. Durations
are milliseconds, rounded up. `limit` must be a positive integer and `window` a
positive finite number. Keys are non-empty, well-formed strings (dots are literal).
Use the same options for a key on every call.

Calls are atomic across processes and participate in `db.transaction()`.
`db.table()` isolates rate-limit keys; `db.resetRateLimit(key)` restores a key's
capacity. The clock is `Date.now()`, just like TTLs. `purgeExpired()` also removes
fully refilled rate-limit rows (theoretical arrival time ≤ now) and includes them in its count.
Writable opens perform the same purge; no background timers are used.

## Durability and concurrency

- **Every call is atomic.** `add`, `push`, `pull`, path `set`/`delete` read and
  write inside one `BEGIN IMMEDIATE` transaction, which takes SQLite's write
  lock *before* reading. Two processes (bot shards, a dashboard, a cron script)
  can share one file without losing updates; `test/multiprocess.test.mjs` proves
  it with 6 processes hammering one file.
- `transaction(fn)` makes several calls atomic together. Throwing inside `fn`
  rolls everything back. Callbacks must not start asynchronous work: native
  `async` functions are rejected before invocation; other returned promises
  cause rollback but cannot cancel work the callback already scheduled.
- **WAL journal.** Readers never wait for writers. Adds `-wal` and `-shm` files
  next to the database. Do not copy just the main file while a bot is running;
  use [`backup()`](#backups) for a consistent standalone copy.
- **`synchronous: "full"` (default)**: once a call returns, the write survives
  a power cut. **`"normal"`**: survives a crash of your process, but the last
  writes before a power cut or OS crash can be lost; the file is never
  corrupted. `"normal"` is ~60× faster for single writes on the benchmark machine.
- Waiting for another process's lock gives up after `busyTimeout` ms (default
  5000) with `database is locked`. Many processes writing non-stop can make one
  wait seconds; raise `busyTimeout` for such setups ([details](docs/decisions.md#7-concurrency-wal-immediate-transactions-busy-polling)).
- All processes must be on the same machine (no network drives).

## Backups

```js
// ESM top-level await, or inside an async function in CommonJS:
await db.backup("bot-backup.sqlite");
db.close();
```

```sh
npx depo backup bot.sqlite --to bot-backup.sqlite
```

The built-in SQLite online-backup API includes committed WAL data and every
namespace, leaderboard, rate-limit row and metadata record. A `table()` view
still backs up the **whole file**. Reopen the completed backup with
`new Depo("bot-backup.sqlite")`; to restore it as the live database, stop the old
connection first. TTLs keep their absolute deadlines, not fresh durations.

Unlike ordinary native methods, `backup()` returns a promise. **Await it before
closing the source or using the target.** Calling it inside `transaction()` or
closing a connection while its backup is pending throws `DepoError`.
The destination must not exist (including the source itself); parent directories
must exist. No overwrite/retention policy is applied. A failed call removes its
new partial file; a crash can leave one, so only a successful completion certifies
the destination. Existing target files are never overwritten.

The CLI opens the source read-only, without creating a missing source or
upgrading its schema. Online writes may continue; a completed backup is
consistent, but may include writes made after the call began. Heavy continuous
writing can delay completion.

## Migrating from wio.db

```diff
- const { JsonDatabase } = require("wio.db");
+ const { JsonDatabase } = require("depo.db/wiodb");
```

Your code keeps working. On first start the existing `databases/db.json` is
imported once into `databases/db.sqlite`; the JSON file is left untouched as a
backup. Every wio.db method is supported; the few intentional differences (bug
fixes such as `substr` on a 0 balance, key order, no `YamlDatabase`) are listed
in [docs/compat-wiodb.md](docs/compat-wiodb.md).

The same `.sqlite` file can later be opened with `new Depo("databases/db.sqlite")`.

## Migrating from quick.db

```diff
- const { QuickDB } = require("quick.db");
+ const { QuickDB } = require("depo.db/quickdb");
```

`depo.db/quickdb` reads and writes quick.db's own `json.sqlite` format, so there is
nothing to convert, and you can uninstall `better-sqlite3`. The file stays
readable by quick.db if you ever go back. Same async API and return values;
differences (only `SqliteDriver`/`MemoryDriver`, two bug fixes, atomic
operations) are in [docs/compat-quickdb.md](docs/compat-quickdb.md).

## `depo migrate`: move data to the native API

```sh
npx depo migrate databases/db.json --to bot.sqlite                 # wio.db
npx depo migrate croxydb/croxydb.json --from croxydb --to bot.sqlite  # croxydb, keeps TTLs
npx depo migrate json.sqlite --to bot.sqlite                        # quick.db, all tables
```

```
databases/db.json (wio) -> bot.sqlite
  databases/db.json -> namespace "default": read 11, inserted 11, updated 0, unchanged 0, conflicts 0
Total: read 11, inserted 11, updated 0, unchanged 0, conflicts 0
```

- wio.db / croxydb: every top-level key becomes an entry in the namespace given
  by `--namespace` (default `default`). A key with a lone UTF-16 surrogate
  ([Keys](#keys)) fails the migration; nothing is written.
- quick.db: table `json` goes to namespace `default`, any other table (from
  `db.table("economy")`) to the namespace of the same name. `--table` limits
  which tables are read. The source is opened read-only.
- croxydb: with `--from croxydb` TTLs from `croxydb.ttl.json` are kept for
  top-level keys. Encrypted croxydb files must be decrypted first.
- Choose a separate `--to` destination: the source itself (including hard-link
  or symlink aliases) is rejected before opening a writable destination.
- **Safe to run again**: identical entries count as `unchanged`. Entries that
  already exist with a different value are kept and reported as `conflicts`;
  `--overwrite` replaces them. `--dry-run` shows the report and leaves the
  target file unchanged, `--json` prints it as JSON.

## Benchmark

Full results, machine details and method: [docs/benchmark.md](docs/benchmark.md)
(`npm run bench` reproduces them).

Windows (NT 10.0.26300), Intel i5-10600K, Node 24.22.0, median of 3 fresh processes. Lower
is better; libraries at their default settings.

| Workload | Depo | Depo `"normal"` | quick.db + better-sqlite3 | wio.db |
|---|---:|---:|---:|---:|
| `set()` 1 000 new keys | 2.19 s | 0.04 s | 7.43 s | 7.49 s |
| `get()` 10 000 reads | 58 ms | 61 ms | 545 ms | 9 336 ms |
| `add()` 1 000 × one key | 2.17 s | 0.04 s | 7.19 s | **2.00 s** |
| insert 5 000 keys, `set()` loop | 10.9 s | 0.18 s | 35.8 s | 52.3 s |
| insert 5 000 keys, one `transaction()` | 18 ms | 17 ms | (no API) | (no API) |
| `all()` over 10 000 keys, ×20 | 280 ms | 271 ms | 280 ms | **200 ms** |
| open 10 000-key file + first `get()` | 7.6 ms | 7.0 ms | 23.8 ms | 38.3 ms |

- Depo's default fsyncs every write (≈ 2.2 ms each on this disk); wio.db never
  fsyncs, so its fair comparison is the `"normal"` column.
- **Depo loses** on `all()` over many entries (wio.db parses one big JSON string
  instead of 10 000 small ones) and roughly ties wio.db on a single hot key at
  default durability.
- Batching writes in `transaction()` is the biggest win: 600× faster than a loop.

## Limitations

- Node.js ≥ 24.15.0 only (see above). Node 22 works but prints an
  `ExperimentalWarning` and is not supported.
- Synchronous: a slow disk blocks the event loop for the duration of a write
  (about 2 ms per fsynced write on the benchmark machine; use
  `synchronous: "normal"` or `transaction()` to batch).
- One SQLite row per top-level key: a path read or write parses and, for writes,
  re-serialises the whole entry. Keep entries small (one per user, not one
  `users` object with everyone in it).
- `all()` parses every returned entry; on 10 000 entries it is slower than wio.db's
  single `JSON.parse` of the whole file (see benchmark). Use `prefix`/`limit`/`after`
  for bounded pages, or `keys()` when values are unnecessary.
- TTLs apply to whole entries, not paths; expiry follows the system clock.
- Many processes writing non-stop to one file can wait seconds for the lock
  (not a fair queue); same machine only, no network file systems.
- JSON values only (no `BigInt`, `Map`, `Buffer`, `Date` objects).
- Dual package: ESM and CommonJS builds are separate copies; compare
  `error.name === "DepoError"` rather than `instanceof` if you mix both.

## Development

```sh
npm install
npm test           # build + full test suite (node:test)
npm run typecheck  # tsc strict, no emit
npm run smoke      # pack, install into a scratch project, run ESM/CJS/TypeScript consumers
npm run attw       # check package exports/types with @arethetypeswrong/cli
npm run bench      # benchmark, rewrites docs/benchmark.md
npm run fixtures   # regenerate test/fixtures with the real wio.db, quick.db, croxydb
```

Design decisions and their reasons: [docs/decisions.md](docs/decisions.md).

## License

MIT
