# Depo

A key-value database for Node.js on the built-in `node:sqlite` module.
**Zero dependencies, no native module, no node-gyp**: `npm install` and it works.

Depo is meant as the successor to [wio.db](https://www.npmjs.com/package/wio.db)
(last release 2021) and [quick.db](https://www.npmjs.com/package/quick.db)
(last release 2023, needs the native `better-sqlite3` module that you install
and compile yourself). Both have drop-in compatibility entry points, so moving
over is a one-line change.

> Working name. The package is not published yet (`"private": true`).

- Synchronous API: `get`, `set`, `has`, `delete`, `all`, `add`, `subtract`, `push`, `pull`
- Dot paths into stored objects: `db.add("user.42.coins", 10)`
- TTL per entry, namespaces, multi-key transactions
- Atomic across processes: several bot shards can share one file
- `depo migrate` CLI to import wio.db, croxydb and quick.db data

## Install

```sh
npm install depo
```

Requires **Node.js 24.15.0 or newer**: the first release line where
`node:sqlite` needs no flag and no longer prints an `ExperimentalWarning`
([details](docs/decisions.md#13-minimum-nodejs-version-24150)).

## Quick start

```js
const { Depo } = require("depo");     // or: import { Depo } from "depo";

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
| `all({ prefix?, limit? })` | `{ key, value }[]` | Ordered by key |
| `count()` | `number` | Live entries in this namespace |
| `deleteAll()` | `number` | Entries removed from this namespace |
| `add(key, n)` / `subtract(key, n)` | `number` | Missing counts as 0 |
| `push(key, ...values)` | array | Missing counts as `[]` |
| `pull(key, valueOrPredicate)` | array | Removes every deep-equal element, or where `predicate(el, index)` is true |
| `ttl(key)` | ms \| `null` \| `undefined` | Remaining TTL; `null` = never expires; `undefined` = missing |
| `expire(key, ms \| null)` | `boolean` | Set or clear the TTL of an existing entry |
| `purgeExpired()` | `number` | Delete expired entries from disk (all namespaces) |
| `table(name)` | `Depo` | View of another namespace sharing the connection |
| `transaction(fn)` | `fn`'s result | Synchronous `fn`, all writes commit together |
| `close()` | | Closes the connection (and all `table()` views) |

Also exported: `DepoError` (thrown for invalid keys, values and type
mismatches), `escapeKey(segment)`, `VERSION`, and the TypeScript types `Key`,
`Entry`, `DepoOptions`, `SetOptions`, `AllOptions`.

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

## Durability and concurrency

- **Every call is atomic.** `add`, `push`, `pull`, path `set`/`delete` read and
  write inside one `BEGIN IMMEDIATE` transaction, which takes SQLite's write
  lock *before* reading. Two processes (bot shards, a dashboard, a cron script)
  can share one file without losing updates; `test/multiprocess.test.mjs` proves
  it with 6 processes hammering one file.
- `transaction(fn)` makes several calls atomic together. Throwing inside `fn`
  rolls everything back.
- **WAL journal.** Readers never wait for writers. Adds `-wal` and `-shm` files
  next to the database; keep them together when copying a live database.
- **`synchronous: "full"` (default)**: once a call returns, the write survives
  a power cut. **`"normal"`**: survives a crash of your process, but the last
  writes before a power cut or OS crash can be lost; the file is never
  corrupted. `"normal"` is ~60× faster for single writes on the benchmark machine.
- Waiting for another process's lock gives up after `busyTimeout` ms (default
  5000) with `database is locked`. Many processes writing non-stop can make one
  wait seconds; raise `busyTimeout` for such setups ([details](docs/decisions.md#7-concurrency-wal-immediate-transactions-busy-polling)).
- All processes must be on the same machine (no network drives).

## Migrating from wio.db

```diff
- const { JsonDatabase } = require("wio.db");
+ const { JsonDatabase } = require("depo/wiodb");
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
+ const { QuickDB } = require("depo/quickdb");
```

`depo/quickdb` reads and writes quick.db's own `json.sqlite` format, so there is
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
- `all()` parses every entry; on 10 000 entries it is slower than wio.db's
  single `JSON.parse` of the whole file (see benchmark). Use `prefix`/`limit`.
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
