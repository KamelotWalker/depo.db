# quick.db compatibility (`depo/quickdb`)

```diff
- const { QuickDB } = require("quick.db");
+ const { QuickDB } = require("depo/quickdb");
```

Reference: quick.db **9.1.7** (latest release, published 2023-07-10), API taken
from the published package (`out/index.js`, `out/index.d.ts`,
`out/drivers/SqliteDriver.js`).

## What is the same

- Exports `QuickDB`, `SqliteDriver`, `MemoryDriver`, and the `IQuickDBOptions` type.
- `new QuickDB({ filePath = "json.sqlite", table = "json", normalKeys = false, driver })`.
- Every method with the same signature and async behaviour: `init`, `all`,
  `get`, `set`, `has`, `delete`, `deleteAll`, `add`, `sub`, `push`, `unshift`,
  `pop`, `shift`, `pull`, `startsWith`, `table`, `tableAsync`,
  `useNormalKeys`, `createSingleton`, the `driver` getter.
- Key handling: `"a.b.c"` splits at the first dot into the row `a` and the
  lodash path `b.c` (bracket indices such as `items[0]` work); `normalKeys`
  disables splitting.
- Return values and their quirks, e.g. `set("a.b", 1)` resolves to the whole
  `a` object, `get("missing.path")` resolves to `undefined` while
  `get("missing")` resolves to `null`, `add` on a non-numeric string stores
  `null` (quick.db computes `NaN`, which JSON stores as `null`).
- Error messages (`"First argument (key) needs to be a string"`,
  `"Missing second argument (value)"`, ...), thrown as plain `Error`.
- **On-disk format.** The same `json.sqlite` file with the same
  `(ID TEXT PRIMARY KEY, json TEXT)` table per quick.db table. Existing files
  open without conversion, and files written by Depo stay readable by quick.db.

`test/quickdb-compat.test.mjs` runs a 75-step scenario against the real
quick.db 9.1.7 and the compat layer and requires identical results and error
messages at every step.

## Intentional differences

| # | quick.db 9.1.7 | depo/quickdb | Why |
|---|---|---|---|
| 1 | Needs the native `better-sqlite3` module | Uses built-in `node:sqlite` | The point of the package |
| 2 | Read-modify-write methods (`add`, `sub`, `push`, `unshift`, `pop`, `shift`, `pull`, dotted `set`/`delete`) are a separate read and write; two calls can interleave, even inside one process | Each runs in one immediate SQLite transaction; atomic across processes | Lost updates |
| 3 | File stays in rollback-journal mode | File is switched to WAL on open (persistent; adds `-wal`/`-shm` files next to it). quick.db/better-sqlite3 still open it | Concurrent readers and writer |
| 4 | `pull(key, value, true)` stops copying after the first element it keeps: `[1, 2, 1, 3]` → `[2]` | Removes only the first matching element: `[1, 2, 1, 3]` → `[2, 1, 3]` | Data loss bug |
| 5 | `delete("a.b")` treats the key as a path even with `normalKeys: true` (and creates row `a`) | With `normalKeys`, deletes the literal key `a.b` | Bug; contradicts `get`/`set` |
| 6 | `pop`/`shift` resolve before their write is done | The write completes first | Ordering |
| 7 | Table names are pasted into SQL | Table names are quoted | Names with quotes/spaces broke or injected SQL |
| 8 | Drivers: `SqliteDriver` (better-sqlite3), `MemoryDriver` (Map), `JSONDriver`, `MongoDriver`, `MySQLDriver`, `PostgresDriver` | Only `SqliteDriver` (node:sqlite) and `MemoryDriver` (in-memory SQLite). Passing any other driver throws. The driver-related types (`IDriver`, `Table`, `DataLike`, `Config`, `CollectionInterface`) are not exported | Out of scope; Depo is SQLite only |
| 9 | `createSingleton()` throws unless a driver is passed | Creates the instance with the given options | quick.db's check made the default driver unusable |
| 10 | `driver.database` is a better-sqlite3 `Database` | It is a `node:sqlite` `DatabaseSync` (different API). `driver.close()` added | Different engine |
| 11 | `SqliteDriver.setRowByKey(..., update)` runs `UPDATE` or `INSERT` depending on `update` | Always upserts; `update` is ignored | Race-free |
| 12 | Paths read inherited properties (`get("x.constructor")` returns `Object`) | Paths read own properties only | Never return functions from data |

## Not supported

- Custom drivers (see 8).
- The `IDriver` interface for writing your own drivers.
