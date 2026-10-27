# Changelog

## 0.3.0 — Unreleased

### Added

- Keyset pagination: `all({ prefix?, limit?, after? })` resumes after an exclusive literal entry key using SQLite BINARY ordering.
- `keys(options)` uses the same filtering/pagination without loading or decoding JSON values.
- Online whole-file backups through `await db.backup(target)` and `depo backup <source> --to <target>`, including committed WAL data, every namespace, TTL deadlines, leaderboards and rate limits. Existing destinations are never overwritten.
- Runnable framework-agnostic Discord bot and quick.db migration examples, exercised by the test suite.
- Package discoverability guide (`llms.txt`) and English/Turkish installation/comparison FAQs.

### Fixed

- Prefix queries now include keys continuing with U+10FFFF and correctly handle the surrogate gap when computing the range boundary.
- Native async transaction callbacks are rejected before they can run, preventing writes after an `await` from escaping a transaction that has already been rejected.
- Migration rejects a destination that aliases its source (including hard links/symlinks), instead of adding native tables to the original quick.db file.
- README (English/Turkish) and `llms.txt` JavaScript examples are standalone, close their connections, and use non-colliding backup/migration destinations. Every JavaScript fence is exercised independently as both ESM and CommonJS during `npm test`.
- Clarified that repository compatibility tests/benchmarks use native dev dependencies and may need local npm install-script approval; installing `depo.db` in an application remains native-addon-free.

### Compatibility

- Remains zero-runtime-dependency and requires Node.js >=24.15.0.
- No on-disk schema change: existing 0.1.x/0.2.x Depo files continue to work.
- Existing `all()` calls retain their unlimited default; set a limit for bounded pages. Pages are live views, not snapshots across calls.
- Unlike native data operations, `backup()` is asynchronous: await success before opening the destination or closing the source. A crash can leave an incomplete destination.
