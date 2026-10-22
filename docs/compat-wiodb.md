# wio.db compatibility (`depo/wiodb`)

```diff
- const { JsonDatabase } = require("wio.db");
+ const { JsonDatabase } = require("depo/wiodb");
```

Reference: wio.db **4.0.22** (latest release, published 2021-12-27; registry metadata last changed 2022-05-24), API taken
from the published package (`src/JsonProvider.js`, `types/index.d.ts`).

## Where the data goes

wio.db rewrites a whole JSON file on every write. Depo keeps the data in SQLite
instead, in a file next to the configured JSON path:

| `databasePath` | SQLite file |
|---|---|
| `databases/db.json` (default) | `databases/db.sqlite` |
| `./data/bot` | `./data/bot.sqlite` |
| `./data/` | `./data/db.sqlite` |

On the **first open** of that SQLite file, an existing wio.db JSON file at
`databasePath` is imported once (top-level keys become entries). The JSON file
is never modified or deleted; keep it as a backup. Pass `importJson: false` to
start empty. The import runs in one transaction with a marker in the file, so
two processes starting at once import exactly once.

The SQLite file is a regular Depo database (namespace `default`): later you can
switch to the native API with `new Depo("databases/db.sqlite")`.

## What is the same

- Exports `JsonDatabase` and `DatabaseError`; types `IOptions`, `Schema`, `IInfo`.
- Every `JsonDatabase` method and property: `set`, `get`, `fetch`, `exists`,
  `has`, `all`, `fetchAll`, `toJSON`, `delete`, `deleteAll`, `type`, `pull`,
  `valueArray`, `keyArray`, `math`, `add`, `substr`, `push`, `includes`,
  `startsWith`, `filter`, `sort`, `destroy`, `findAndDelete`, `info`, `path`,
  `maxDataSize`, `size`.
- Keys use lodash path syntax exactly like wio.db: `"user.42.name"`,
  `"items[0]"`; numeric segments below `Number.MAX_SAFE_INTEGER` create arrays
  (`set("slots.2", "x")` → `[null, null, "x"]`), Discord snowflakes create object
  keys. `exists`/`has` only look at top-level keys, as in wio.db.
- Validation and messages: `"Unapproved key!"`, `"Unapproved value!"` (for
  `""`, `null`, `undefined`), `"autoWrite parameter must be true or false!"`,
  `"Value cannot be less than 1."`, `"The type of value is not a number."`, ...
- `get(key)` returns `null` for missing keys unless a default is given;
  `push` replaces a non-array value with `[value]`; `substr` clamps results
  below 1 to 0 unless `goToNegative` is true; `pull` returns `false` when the
  key holds a falsy value.

`test/wiodb-compat.test.mjs` runs a 94-step scenario against the real wio.db
4.0.22 and the compat layer and requires identical results and error messages
at every step (list results compared after sorting, see difference 4).

## Intentional differences

| # | wio.db 4.0.22 | depo/wiodb | Why |
|---|---|---|---|
| 1 | Data in a JSON file rewritten on every write | Data in SQLite next to it; JSON imported once (see above). `path` is the SQLite file; `jsonPath` added | Speed, crash safety |
| 2 | Concurrent processes overwrite each other's writes | Every method is atomic across processes | Data loss |
| 3 | `math`/`add`/`substr` on a missing or falsy (0) value store `+value` for every operator: `substr("x", 5)` on a missing key gives `5` | Start from 0: `substr` gives `0` (or `-5` with `goToNegative`), `*`, `/`, `%` give `0`; `add` is unchanged | Bug: a balance of 0 minus 5 became 5 |
| 4 | `all()`, `keyArray()`, `toJSON()`, ... in insertion order (JS object order) | Ordered by key (byte order); `all(limit)` returns the first `limit` keys in that order | SQLite primary-key order |
| 5 | `pull(key, fn)` without a match removes the last element | Removes nothing | Data loss bug |
| 6 | `size` / `info.size` count `set`/`delete` calls of this process | Actual number of top-level keys | The original counter is meaningless |
| 7 | `maxDataSize` compares against that counter (updates count too) | Limits the number of top-level keys; only creating a new key can exceed it | Same |
| 8 | `info.version` is `"4.0.21"` | Depo's version | |
| 9 | `autoWrite: false` skips writing (the change is lost) | Accepted and validated, but every write is persisted | No silent data loss |
| 10 | `destroy()` deletes the JSON file | Closes the database and deletes the SQLite file (`-wal`/`-shm` too); the JSON file is kept | Data lives in SQLite |
| 11 | `DatabaseError` messages are ANSI-coloured and followed by a Discord advertisement; `name` is coloured | Plain message, `name === "DatabaseError"` | |
| 12 | Absolute `databasePath` values outside the working directory break (the cwd is prefixed); directories are only created when the path uses the platform separator | Absolute paths are honoured; directories are always created | Bug (Windows) |
| 13 | Paths read inherited properties (`get("toString")` returns a function) | Own properties only | Never return functions from data |
| 14 | `findAndDelete` deletes one key at a time | All deletions in one transaction | Atomicity |
| 15 | `pull()` is typed as returning `V` | Typed `V \| false` (it returns `false` in both libraries) | Honest types |
| 16 | — | `close()` added; `busyTimeout`, `synchronous`, `importJson` options added | |
| 17 | Top-level keys containing a lone UTF-16 surrogate (`"a\uD800"`) are stored (JSON escapes them) | Throw `DepoError`; a wio.db JSON file with such a key is not imported | SQLite stores UTF-8, where such keys would merge and overwrite each other |

## Not supported

- `YamlDatabase`. Depo has zero dependencies and therefore no YAML parser.
  Convert the YAML file to JSON (same structure) and use `JsonDatabase`, or run
  `depo migrate` on the JSON.
