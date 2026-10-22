# Design decisions

Where several reasonable options existed, Depo picks the boring, safe one. Each
entry says what was chosen, what was rejected, and why.

## 1. Storage: one SQLite file, one table

Data lives in a single table:

```sql
CREATE TABLE depo_entries (
  ns         TEXT NOT NULL,     -- namespace, see `table()`
  key        TEXT NOT NULL,     -- first key segment
  value      TEXT NOT NULL,     -- JSON text
  expires_at INTEGER,           -- epoch ms, NULL = never
  PRIMARY KEY (ns, key)
) WITHOUT ROWID;
CREATE INDEX depo_entries_expires_at ON depo_entries (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE depo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;  -- schema_version = 1
```

- **Namespaces are a column, not SQL tables.** quick.db creates one SQL table per
  `table()` name and interpolates the name into SQL. A column needs no dynamic
  identifiers, so no user string ever becomes SQL.
- **Schema version** is stored in `depo_meta`. A file written by a newer schema
  is refused with a clear error instead of being misread.
- Opening an existing file only reads; the schema is created inside a write
  transaction only when it is missing (see §7 for why that matters).

## 2. Values: JSON text

Rejected: SQLite JSONB, `v8.serialize`, structured clone.

- JSON is what quick.db and wio.db store, so migrated data keeps its meaning and
  `migrate` is a straight copy.
- The file stays inspectable with any SQLite tool.
- Consequences, all documented in the README: `undefined`, functions, symbols
  and BigInt are rejected with `DepoError`; `Date` becomes an ISO string;
  `NaN`/`Infinity` become `null` (plain `JSON.stringify` behaviour).
- The value passed to a path `set` or to `push` is checked *before* it is
  embedded in the entry: once inside an object or array, `JSON.stringify` would
  silently drop a function or symbol property or store `null` for it, so the
  call would succeed while losing or changing data. Functions and symbols
  nested deeper inside a stored object follow plain `JSON.stringify` rules.
- `get()` returns a freshly parsed value; mutating it never changes the store.

## 3. Keys: dots are paths, backslash escapes

- `"user.42.coins"` → entry `user`, path `42 → coins` inside its JSON value.
- `\.` is a literal dot, `\\` a literal backslash. Any other backslash sequence
  and any empty segment (`""`, `"a..b"`, `".a"`, `"a."`) throw. Being strict
  means a typo never silently addresses a different key.
- The array form `["site.com", "visits"]` needs no escaping; `escapeKey()`
  escapes a single segment for string keys.
- The *first segment is the SQLite row*. Only that part is indexed; paths are
  resolved in JavaScript after reading the row.
- Entry keys (the first segment) and namespaces must be well-formed Unicode: a
  lone UTF-16 surrogate (`"a\uD800"`) throws `DepoError`. SQLite stores text as
  UTF-8, which has no encoding for it and substitutes U+FFFD, so `"a\uD800"`
  and `"a\uD801"` would address the same row and overwrite each other. The
  check sits in the storage layer, so the wio.db layer and `migrate` get it
  too. Path segments after the first are unaffected: they live inside the
  JSON value, which escapes surrogates losslessly (also in `depo/wiodb`, whose
  `get("obj.\uD800")` works like wio.db's). Rejected: a lossless
  encoding of such keys. Other readers of the file (SQLite tools, older Depo
  versions) would see the encoded form, and a lone surrogate in a key is
  almost always a bug, such as a string cut in the middle of an emoji.

Rejected: lodash path syntax (`a[0].b`) in the native API. It has two ways to
say the same thing and no escape for a literal `.` or `[`. The compatibility
layers do use lodash syntax, because quick.db and wio.db do.

## 4. Path writes never guess

- Missing intermediate containers are created as **plain objects**, even for
  numeric segments: `set("slots.2", "x")` gives `{ slots: { "2": "x" } }`.
  lodash (quick.db, wio.db) creates `[null, null, "x"]` instead, which is what
  turns `set("user.12345.name", ...)` into a 12 346-element array.
- Existing arrays are indexed by canonical indices (`"0"`, `"1"`, ...). Writing
  index `length` appends; a larger index throws (no holes); a non-index segment
  on an array throws.
- Writing through a primitive (`set("n.x", 1)` when `n` is `5`) throws instead of
  replacing the number with an object.
- Deleting an array index splices the element out.
- `__proto__`, `constructor` and `prototype` are ordinary data keys; reads only
  follow own properties and writes define own properties, so nothing reaches
  `Object.prototype`.

## 5. Missing vs `null`

`get()` returns `undefined` (or the given default) for a missing key; `null` is
a storable value and `has()` is true for it. `set(key, undefined)` throws: use
`delete()`.

## 6. Synchronous API

`node:sqlite` is synchronous. Wrapping it in promises would add latency and
make transactions impossible to reason about (an `await` inside a transaction
would let other code run while the write lock is held). The quick.db
compatibility layer keeps quick.db's async signatures on top of the same
synchronous core.

## 7. Concurrency: WAL, immediate transactions, busy polling

- **WAL journal**: readers never block the writer and the writer never blocks
  readers. Set on open (`PRAGMA journal_mode = WAL`, persistent in the file).
- **Every read-modify-write runs in `BEGIN IMMEDIATE`** (`add`, `subtract`,
  `push`, `pull`, path `set`/`delete`, `deleteAll`, compat-layer equivalents).
  The write lock is taken *before* the read, so two processes can never both
  read the old value. Whole-value `set`/`delete` are single statements and
  atomic on their own.
- `transaction(fn)` exposes the same mechanism for multi-key changes.
- **Busy handling in JavaScript.** SQLite's built-in busy handler backs off to
  100 ms sleeps. With several processes writing continuously a waiter that only
  wakes every 100 ms rarely finds the lock free. Measured on this machine with
  Node 24.15.0 (6 processes, each running 150 iterations of three fsynced write
  transactions with a 0–1 ms pause per iteration): with SQLite's handler the
  slowest single operation waited **4.2 s**, and in the multi-process test one
  worker hit the 5 s timeout. Depo therefore sets SQLite's busy timeout to 0 on
  writable connections and retries `SQLITE_BUSY` itself every 1–2 ms (with
  jitter) until `busyTimeout` (default 5000 ms) runs out. In the same
  measurement the slowest operation then waited **1.8 s** (worst of 3 runs;
  most workers' worst case was 0.4–1.6 s). Only operations that change nothing
  when they fail with `SQLITE_BUSY` are retried (`BEGIN IMMEDIATE`, `COMMIT`,
  single statements outside a transaction), never user callbacks.
  The deadline is measured on the monotonic clock (`performance.now()`), so a
  system clock change during a wait neither stretches nor cuts it (TTLs, by
  contrast, are wall-clock times, see §9).
- This is still not a fair queue. Several processes writing flat out can make one
  of them wait seconds; such setups should raise `busyTimeout`. A Discord bot
  with a few writes per second per process is nowhere near this.
- Opening an existing file takes no write lock (schema check by reading;
  expired-row purge only when something has expired), so a process started
  while others are busy writing does not have to win the lock to start.
- WAL needs shared memory between the processes: all of them must run on the
  same machine. Network file systems are not supported (SQLite's own rule).

The multi-process test (`test/multiprocess.test.mjs`) runs 6 processes × 150
iterations of `add`, `push`, path `add` and a two-key transfer transaction on
one file and checks that nothing is lost (for the native API and both
compatibility layers). The workers use `busyTimeout: 60000`: the test checks
atomicity, not lock latency. A control group doing an unsafe `get` + `set` in
the same setup loses most of its updates (75–87 % in the runs so far) and the
test asserts that it loses some, which proves the workers really overlap.

## 8. Durability: `synchronous = FULL` by default

- Default `"full"`: every committed write is fsynced and survives power loss.
  This matches quick.db/better-sqlite3's default (SQLite's own default).
- Opt-in `synchronous: "normal"`: in WAL mode commits survive a process crash
  but the most recent ones can be lost on power loss or an OS crash. The file is
  never corrupted either way. It is much faster for single writes (see
  docs/benchmark.md).

Rejected: defaulting to `"normal"` for nicer benchmark numbers.

## 9. TTL: per entry, lazy expiry, no timers

- `set(key, value, { ttl })` stores an absolute expiry (`Date.now() + ttl`).
  TTLs apply to whole entries; a TTL on a path throws.
- Expired entries are invisible to every read immediately (all queries filter
  on `expires_at`) and are treated as missing by writes (`add` on an expired
  counter starts from 0).
- Space is reclaimed when a file is opened and by `purgeExpired()`. No
  background timer: timers keep processes alive, fire during transactions, and
  add a moving part for something reads already handle.
- Whole-entry `set` without `ttl` clears the TTL (like Redis `SET`). Path writes,
  `add`, `push`, `pull` keep it. `expire(key, ms | null)` changes it.
- Expiry uses the wall clock; changing the system clock moves expiries.

## 10. Transactions

`transaction(fn)` runs `fn` in `BEGIN IMMEDIATE ... COMMIT`; any exception rolls
back and is rethrown. Nested calls use savepoints, so a caught inner failure
only undoes the inner part. A callback returning a promise is rolled back and
rejected with an error: the transaction would otherwise commit before the
promise settles.

## 11. Compatibility layers

- **quick.db** (`depo/quickdb`) reads and writes quick.db's own on-disk format
  (`json.sqlite`, one `(ID, json)` table per table name). Switching the
  `require` line needs no data conversion and stays reversible: the file
  remains readable by quick.db. Behaviour is checked operation by operation
  against the real quick.db 9.1.7 (`test/quickdb-compat.test.mjs`).
- **wio.db** (`depo/wiodb`) cannot keep wio.db's format (rewriting a JSON file on
  every call is the problem being solved). It stores into a Depo file next to
  the JSON path and imports the JSON file once, inside a write transaction and
  guarded by a marker in `depo_meta`, so concurrent first opens import exactly
  once. The JSON file is never modified. The result is a regular Depo file
  (`default` namespace) that the native API can open later. Behaviour is checked
  against the real wio.db 4.0.22 (`test/wiodb-compat.test.mjs`).
- Path handling in both layers is a port of the relevant lodash 4.17.21
  internals (`_stringToPath`, `_isKey`, `_baseSet`, `_baseUnset`, MIT), so dotted
  keys, bracket indices and lodash's array creation behave identically. One
  deliberate change: reads follow own properties only.
- Each intentional behaviour difference is listed in
  [compat-quickdb.md](compat-quickdb.md) and [compat-wiodb.md](compat-wiodb.md).
  Differences were kept only where the original loses or corrupts data.

## 12. `migrate` CLI

- Idempotent: entries already present with the same value (and expiry) count as
  *unchanged*; re-running changes nothing.
- Entries present with a *different* value are **kept** and reported as
  conflicts unless `--overwrite` is given. The safe default never destroys data
  written after a first migration.
- The whole import is one transaction. `--dry-run` does not create a missing
  target file (an empty in-memory database stands in). An existing target's
  main file and `-wal` stay byte-for-byte unchanged:
  - Without `-wal`/`-shm` files (no process has it open) it is opened in
    preview mode: one transaction covers everything from opening (schema
    creation, the expired-row purge) to the import and is rolled back on
    close, and the journal mode is not switched to WAL. Closing deletes the
    `-wal`/`-shm` files it created, as any last connection does.
  - With them (a process has it open, or a writer exited without closing)
    a writable connection would checkpoint the WAL into the main file when
    it closes as the last connection. The live entries of the affected
    namespaces are instead copied into an in-memory database through a
    read-only connection, which never writes the main file or the WAL and
    takes no write lock. Like every reader it may update the `-shm` file,
    SQLite's shared-memory index of the WAL (read marks, or rebuilding it
    after a writer crashed); it holds no data and SQLite rebuilds it from
    the WAL.
- quick.db tables are recognised by their layout (`ID` and `json` columns).
  Only SQLite's reserved `sqlite_` names are skipped; the `_` is escaped in
  the `LIKE` pattern, where it would otherwise match any character and also
  skip tables such as `sqliteData`.
- quick.db sources are opened read-only and read inside one read transaction,
  so all tables come from one snapshot even if the bot is still running.
- croxydb's `jsondb` format turned out to be the same layout as wio.db (verified
  by generating files with croxydb 0.0.27). `--from croxydb` additionally reads
  the `<name>.ttl.json` sidecar: TTLs of top-level keys are carried over as
  absolute expiries, already-expired keys are skipped, TTLs on nested paths are
  reported as warnings. Encrypted croxydb files are refused with instructions.

## 13. Minimum Node.js version: 24.15.0

| Version | `node:sqlite` status |
|---|---|
| 22.5.0 | Added behind `--experimental-sqlite` |
| 22.13.0 / 23.4.0 | No flag needed, still Stability 1.1 "Active development"; prints `ExperimentalWarning: SQLite is an experimental feature` on load |
| 24.15.0 / 25.7.0 | Stability 1.2 "Release candidate"; the warning is gone ([nodejs/node#61262](https://github.com/nodejs/node/pull/61262), which removes the `emitExperimentalWarning('SQLite')` call) |
| 26.11.0 | `DatabaseSync` renamed `Database`; old name is a documentation-only deprecation (DEP0210). Depo uses `Database` when it exists |

Sources: [SQLite docs, history table](https://nodejs.org/api/sqlite.html),
[v24.x docs](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) ("v24.15.0 SQLite is now a release candidate"),
[v22.x docs](https://nodejs.org/docs/latest-v22.x/api/sqlite.html) (still 1.1 in v22.23.4),
[v24.15.0 changelog](https://nodejs.org/en/blog/release/v24.15.0) (`aaf9af1672 sqlite: mark as release candidate`).

Verified locally with the official Windows x64 builds:

- v22.23.4 (latest 22.x) and v24.14.1: loading `node:sqlite` prints the
  `ExperimentalWarning`. Depo itself works on both.
- v24.15.0: no warning; the full test suite passes.
- APIs Depo relies on beyond the basics (`timeout` constructor option,
  `isTransaction`) exist since v24.0.0 / v22.16.0.

A warning printed on every bot start, on a module the Node project itself
labels experimental, is the "stability blocker", so `engines` is
`>=24.15.0`. Node 22 users can run Depo but get the warning and are not
supported.

## 14. Packaging

- Zero runtime dependencies; everything else is a devDependency.
- TypeScript strict, compiled twice by `tsc` (ESM to `dist/esm`, CommonJS to
  `dist/cjs`) with a `package.json` marking each directory's module type.
  `exports` maps `import`/`require` to the matching `.js` and `.d.ts`;
  `typesVersions` covers TypeScript's legacy `node10` resolution. Checked with
  `@arethetypeswrong/cli` and by `scripts/smoke.mjs`, which installs the packed
  tarball into a scratch project and runs ESM, CommonJS and TypeScript
  (nodenext, node16, bundler) consumers.
- Dual-package hazard: ESM and CJS copies are separate module instances, so a
  `DepoError` thrown by the CJS build is not `instanceof` the ESM `DepoError`.
  Check `error.name === "DepoError"` when mixing both.
- The native API does not create parent directories (SQLite's behaviour); the
  wio.db layer does, because wio.db did.
