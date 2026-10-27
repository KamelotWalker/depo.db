import assert from "node:assert/strict";
import { test } from "node:test";
import { runReadmeExamples } from "../scripts/readme.mjs";

test("all documented JavaScript examples run independently through ESM and CommonJS exports", (t) => {
  const result = runReadmeExamples();
  assert.deepEqual(result.documents.map(({ file }) => file), [
    "README.md", "docs/README.tr.md", "llms.txt",
  ]);
  assert.ok(result.documents.every(({ snippets }) => snippets > 0));
  assert.equal(result.snippets, result.documents.reduce((sum, doc) => sum + doc.snippets, 0));
  assert.equal(result.esm, result.snippets);
  assert.equal(result.cjs, result.snippets);
  t.diagnostic(`${result.snippets} JavaScript fences: ${result.esm} ESM + ${result.cjs} CommonJS executions`);
});
