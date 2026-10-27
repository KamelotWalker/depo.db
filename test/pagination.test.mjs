import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { Depo, DepoError } from "../dist/esm/index.js";
import { onCleanup, tempDir } from "./helpers.mjs";

function open(t) {
  const db = new Depo(join(tempDir(t), "db.sqlite"));
  onCleanup(t, () => db.close());
  return db;
}

for (const method of ["all", "keys"]) {
  const names = (page) => method === "keys" ? page : page.map(({ key }) => key);

  test(`${method}: keyset pages cover BINARY ordering with literal cursors`, (t) => {
    const db = open(t);
    const expected = ["A", "a.b", "a\\b", "z", "é", "\uE000", "😀", "\u{10FFFF}"];
    db.transaction(() => {
      for (const key of expected.toReversed()) db.set([key], { key });
    });
    let after;
    const visited = [];
    for (;;) {
      const page = db[method]({ limit: 2, after });
      if (page.length === 0) break;
      const keys = names(page);
      visited.push(...keys);
      after = keys.at(-1);
    }
    assert.deepEqual(visited, expected);
    assert.deepEqual(names(db[method]({ after: "a.c", limit: 2 })), ["a\\b", "z"]);
    assert.deepEqual(db[method]({ after: "\u{10FFFF}" }), []);
    assert.deepEqual(db[method]({ limit: 0 }), []);
    assert.equal(db[method]({ limit: Number.MAX_VALUE }).length, expected.length);
    assert.deepEqual(names(db[method]({ after: "" })), expected);
  });

  test(`${method}: prefix ranges include maximum code points and Unicode boundaries`, (t) => {
    const db = open(t);
    const keys = ["p", "p%_", "p\u0000", "p\u0000x", "p\uD7FF", "p\uE000", "p\u{10FFFF}", "p\u{10FFFF}x", "q", "\u{10FFFF}", "\u{10FFFF}x"];
    db.transaction(() => { for (const key of keys) db.set([key], key); });
    for (const prefix of ["p", "p%_", "p\u0000", "p\uD7FF", "p\u{10FFFF}", "\u{10FFFF}", "nope"]) {
      const expected = keys.filter((key) => key.startsWith(prefix)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      assert.deepEqual(names(db[method]({ prefix })), expected, JSON.stringify(prefix));
      let after;
      const visited = [];
      for (;;) {
        const page = names(db[method]({ prefix, after, limit: 1 }));
        if (page.length === 0) break;
        visited.push(...page);
        after = page.at(-1);
      }
      assert.deepEqual(visited, expected);
    }
    assert.deepEqual(names(db[method]({ prefix: "p", after: "a", limit: 1 })), ["p"]);
    assert.deepEqual(db[method]({ prefix: "p", after: "q" }), []);
  });

  test(`${method}: TTLs, namespaces and writes between pages respect the cursor`, (t) => {
    const db = open(t);
    let now = 1_800_000_000_000;
    t.mock.method(Date, "now", () => now);
    db.set("a", 1);
    db.set("b", 2, { ttl: 10 });
    db.set("c", 3);
    db.set("d", 4);
    db.table("other").set("c", 99);
    assert.deepEqual(names(db[method]({ limit: 1 })), ["a"]);
    db.delete("a");
    db.delete("d");
    db.set("0", 0);
    db.set("cc", 33);
    now += 10;
    assert.deepEqual(names(db[method]({ after: "a", limit: 2 })), ["c", "cc"]);
    assert.deepEqual(names(db.table("other")[method]()), ["c"]);
    db.transaction(() => {
      db.set("e", 5);
      assert.deepEqual(names(db[method]({ after: "cc" })), ["e"]);
    });
    db.close();
    assert.throws(() => db[method](), /closed/);
  });

  test(`${method}: invalid options fail with DepoError`, (t) => {
    const db = open(t);
    for (const after of [null, 1, [], {}, "bad\uD800"]) {
      assert.throws(() => db[method]({ after }), DepoError);
    }
    for (const limit of [-1, 0.5, NaN, Infinity, "1", null]) {
      assert.throws(() => db[method]({ limit }), DepoError);
    }
    for (const prefix of [1, [], {}, "bad\uDC00"]) {
      assert.throws(() => db[method]({ prefix }), DepoError);
    }
  });
}

test("keys selects no JSON values; paginated all decodes only its requested rows", (t) => {
  const db = open(t);
  db.set("a", { valid: true });
  const raw = new DatabaseSync(db.path);
  try {
    raw.prepare("INSERT INTO depo_entries (ns, key, value) VALUES (?, ?, ?)").run("default", "b", "not JSON");
  } finally { raw.close(); }
  assert.deepEqual(db.keys(), ["a", "b"]);
  assert.deepEqual(db.keys({ after: "a", limit: 1 }), ["b"]);
  assert.deepEqual(db.all({ limit: 1 }), [{ key: "a", value: { valid: true } }]);
  assert.throws(() => db.all({ after: "a", limit: 1 }), /not valid JSON/);
});

test("pagination reads a 0.1 file without changing its bytes or schema", (t) => {
  const file = join(tempDir(t), "old.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE depo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO depo_meta VALUES ('schema_version', '1');
    CREATE TABLE depo_entries (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (ns, key)) WITHOUT ROWID;
    CREATE INDEX depo_entries_expires_at ON depo_entries (expires_at) WHERE expires_at IS NOT NULL;
    INSERT INTO depo_entries VALUES ('default', '', '0', NULL), ('default', 'a', '1', NULL), ('default', 'b', '2', NULL);
  `);
  raw.close();
  const before = readFileSync(file);
  const db = new Depo(file, { readOnly: true });
  try {
    assert.deepEqual(db.keys(), ["", "a", "b"]);
    assert.deepEqual(db.keys({ after: "", limit: 1 }), ["a"]);
    assert.deepEqual(db.all({ after: "a", limit: 1 }), [{ key: "b", value: 2 }]);
  } finally { db.close(); }
  assert.deepEqual(readFileSync(file), before);
});
