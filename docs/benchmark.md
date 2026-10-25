# Benchmark

`bench/run.mjs` compares Depo with quick.db (+ better-sqlite3) and wio.db on
identical workloads: same keys, same values (`{ id, name, coins, tags }`), same
random read sequence (seeded PRNG). Every cell runs in a fresh Node process in
a fresh directory; the table shows the median of several runs.

All libraries run with their **default settings**, which are not equally
durable:

- **Depo default** fsyncs every commit (`synchronous = FULL`, WAL journal): a
  returned write survives a power cut.
- **quick.db** (better-sqlite3 defaults) is just as durable but uses SQLite's
  rollback journal, which needs more fsyncs per commit.
- **wio.db** rewrites the whole JSON file with `writeFileSync` and never
  fsyncs: a power cut can lose recent writes, a crash during the write can leave
  a truncated file. Its fair comparison is **Depo with `synchronous: "normal"`**,
  which also skips the per-commit fsync but cannot corrupt the file.
- The `depo.db/quickdb` row is Depo's quick.db compatibility layer: the quick.db
  API and file format on `node:sqlite`.

<!-- results:start -->
Generated 2026-10-22T04:13:27.860Z by `npm run bench`.

| | |
|---|---|
| CPU | Intel(R) Core(TM) i5-10600K CPU @ 4.10GHz (12 logical cores) |
| RAM | 63.8 GiB |
| OS | win32 10.0.26300 x64 |
| Node.js | v24.22.0 (node:sqlite → SQLite 3.53.4) |
| quick.db | 9.1.7 with better-sqlite3 13.0.3 (SQLite 3.53.4) |
| wio.db | 4.0.22 |
| Runs | median of 3 fresh processes per cell (cold start: 7) |
| Storage | files under `bench/.work` in the repository (G: drive) |

### set() 1000 new keys, one call each

| Library | Total ms | ops/s | vs Depo default |
|---|---:|---:|---:|
| Depo (default: WAL, synchronous FULL) | 2,190.5 | 457 | 1.00× |
| Depo (synchronous: "normal") | 38.2 | 26,212 | 57.42× |
| depo.db/quickdb compat layer | 2,207.3 | 453 | 0.99× |
| quick.db 9.1.7 + better-sqlite3 | 7,428.8 | 135 | 0.29× |
| wio.db 4.0.22 | 7,492.5 | 133 | 0.29× |

### get() 10000 random reads over 1000 keys

| Library | Total ms | ops/s | vs Depo default |
|---|---:|---:|---:|
| Depo (default: WAL, synchronous FULL) | 57.7 | 173,259 | 1.00× |
| Depo (synchronous: "normal") | 60.7 | 164,812 | 0.95× |
| depo.db/quickdb compat layer | 53.7 | 186,352 | 1.08× |
| quick.db 9.1.7 + better-sqlite3 | 545.2 | 18,343 | 0.11× |
| wio.db 4.0.22 | 9,336.0 | 1,071 | 0.01× |

### add() 1000 times on one hot key

| Library | Total ms | ops/s | vs Depo default |
|---|---:|---:|---:|
| Depo (default: WAL, synchronous FULL) | 2,167.9 | 461 | 1.00× |
| Depo (synchronous: "normal") | 35.8 | 27,959 | 60.61× |
| depo.db/quickdb compat layer | 2,185.1 | 458 | 0.99× |
| quick.db 9.1.7 + better-sqlite3 | 7,194.2 | 139 | 0.30× |
| wio.db 4.0.22 | 1,995.2 | 501 | 1.09× |

### bulk insert 5000 keys with a set() loop

| Library | Total ms | ops/s | vs Depo default |
|---|---:|---:|---:|
| Depo (default: WAL, synchronous FULL) | 10,874.0 | 460 | 1.00× |
| Depo (synchronous: "normal") | 180.0 | 27,781 | 60.42× |
| depo.db/quickdb compat layer | 10,931.8 | 457 | 0.99× |
| quick.db 9.1.7 + better-sqlite3 | 35,801.4 | 140 | 0.30× |
| wio.db 4.0.22 | 52,307.9 | 96 | 0.21× |

### bulk insert 5000 keys in one transaction (Depo only: the others have no transaction API)

| Library | Total ms | ops/s | vs Depo default |
|---|---:|---:|---:|
| Depo (default: WAL, synchronous FULL) | 17.9 | 279,462 | 1.00× |
| Depo (synchronous: "normal") | 17.0 | 293,395 | 1.05× |

### all() over 10,000 keys, 20 calls

| Library | Total ms | ops/s | vs Depo default |
|---|---:|---:|---:|
| Depo (default: WAL, synchronous FULL) | 279.7 | 71 | 1.00× |
| Depo (synchronous: "normal") | 270.7 | 74 | 1.03× |
| depo.db/quickdb compat layer | 299.1 | 67 | 0.94× |
| quick.db 9.1.7 + better-sqlite3 | 279.5 | 72 | 1.00× |
| wio.db 4.0.22 | 199.5 | 100 | 1.40× |

### Cold start: open a file with 10,000 keys and read one

| Library | Library load + open + first get (ms) | Process start → first get (ms) | Size on disk |
|---|---:|---:|---:|
| Depo (default: WAL, synchronous FULL) | 7.6 | 34.5 | 916 KiB |
| Depo (synchronous: "normal") | 7.0 | 34.7 | 916 KiB |
| depo.db/quickdb compat layer | 11.7 | 38.2 | 960 KiB |
| quick.db 9.1.7 + better-sqlite3 | 23.8 | 50.7 | 960 KiB |
| wio.db 4.0.22 | 38.3 | 63.5 | 1,548 KiB |

“vs Depo default” > 1× means faster than Depo's default configuration, < 1× slower.
<!-- results:end -->

## Reading the numbers

**Writes are bounded by fsync.** Depo's default needs one fsync per commit,
about 2.2 ms on this machine, so single writes top out near 460/s whatever the
operation. quick.db pays roughly three times that (≈ 7.3 ms) because the
rollback journal syncs more often. `synchronous: "normal"` removes the per-call
fsync and is ~60× faster; one `transaction()` around a batch gets the same
effect while keeping full durability (5 000 inserts in ~18 ms instead of ~11 s).

**Reads**: Depo `get()` is about 10× faster than quick.db. quick.db prepares a
new SQL statement on every call and goes through `async`/`await`; Depo reuses
prepared statements. The `depo.db/quickdb` layer keeps quick.db's async API and is
still as fast as native Depo here. wio.db parses the entire JSON file on every
`get()`, so it is ~160× slower with only 1 000 keys and gets worse as data grows.

**Where Depo loses**

- **`all()` on 10 000 entries: wio.db is ~1.4× faster.** wio.db does one
  `JSON.parse` of the whole file; Depo (and quick.db, which lands at the same
  speed) fetch 10 000 rows and parse 10 000 small JSON values. Code that scans
  everything on every command (leaderboards) should use `all({ prefix, limit })`
  or keep a summary entry.
- **`add()` on a single hot key: wio.db is about as fast as Depo's default**
  (1.09× in this run, 0.78× in an earlier run on the same machine). With one
  small key wio.db's file rewrite is cheap and, unlike Depo's default, it does
  not fsync. Against `synchronous: "normal"`, the setting with comparable
  durability, Depo is ~55× faster. wio.db's cost grows with the file: `set()` of
  1 000 different keys is already 3.4× slower than Depo's default.
- **Default single writes are ~60× slower than they could be**, by choice:
  durability first. Bots that can afford to lose the last second of writes on a
  power cut can pass `synchronous: "normal"`.
- Not measured here: raw better-sqlite3 without quick.db on top. Depo competes
  with quick.db and wio.db, not with hand-written SQL.

**Cold start**: loading the library, opening a 10 000-key file and reading one
key takes ~8 ms with Depo (no native addon to load, no file to parse), versus
~24 ms for quick.db and ~38 ms for wio.db, which reads and parses the whole
file. The SQLite files are also ~40 % smaller than wio.db's pretty-printed JSON.

Numbers depend heavily on the disk's fsync latency; expect different absolute
values on Linux, SSDs with power-loss protection, or network/cloud disks. The
ratios between libraries are what to compare.
