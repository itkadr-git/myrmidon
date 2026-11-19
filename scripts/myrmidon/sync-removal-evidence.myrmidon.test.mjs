import assert from "node:assert/strict";
import { test } from "node:test";
import { findPossiblyRemovableRows } from "./vendor-sync/lib.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";
const row = (id, cells = {}) => ({ section: "registry", id, cells, raw: id });
const reason = (n) => `vendor #${n} is in the range`;
const commitReason = (id) => `commit ${id} is in the range`;
const run = (rows, prs = [], commits = []) =>
  findPossiblyRemovableRows(rows, { prNumbers: new Set(prs), commitShas: new Set(commits) });

const cases = [
  ["removal column matches", row("A", { "Как снимать": "merge #12" }), [12], [], [reason(12)]],
  ["reason column matches", row("B", { "Причина": "vendor #23" }), [23], [], [reason(23)]],
  ["other columns do not match", row("C", { "PR": "#12", "Описание": "#23" }), [12, 23], [], []],
  ["missing columns do not match", row("D"), [12], [], []],
  ["missing removal column still reads reason", row("E", { "Причина": "#12" }), [12], [], [reason(12)]],
  ["missing reason column still reads removal", row("F", { "Как снимать": "#12" }), [12], [], [reason(12)]],
  ["PR number is not a prefix", row("G", { "Причина": "#123" }), [12], [], []],
  ["PR number matches exactly", row("H", { "Причина": "#123" }), [123], [], [reason(123)]],
  ["repeated reasons are deduplicated in encounter order", row("I", { "Как снимать": "#23 #12 #23", "Причина": "#12 #34 #23" }), [12, 23, 34], [], [reason(23), reason(12), reason(34)]],
  ["seven-digit commit prefix matches", row("vendor:0123456"), [], [sha], [commitReason("0123456")]],
  ["full commit matches", row(`vendor:${sha}`), [], [sha], [commitReason(sha)]],
  ["short vendor id does not match", row("vendor:012345"), [], [sha], []],
  ["long vendor id does not match", row(`vendor:${sha}0`), [], [`${sha}0`], []],
  ["nonhex vendor id does not match", row("vendor:012345g"), [], ["012345g000000000000000000000000000000000"], []],
  ["unrelated commit does not match", row("vendor:0123456"), [], ["abcdef0123456789abcdef0123456789abcdef01"], []],
  ["PR and commit reasons are both reported", row("vendor:0123456", { "Причина": "#12" }), [12], [sha], [reason(12), commitReason("0123456")]],
  ["empty evidence sets do not match", row("vendor:0123456", { "Как снимать": "#12" }), [], [], []],
];

for (const [name, candidate, prs, commits, reasons] of cases) {
  test(name, () => {
    const result = run([candidate], prs, commits);
    assert.deepEqual(result, reasons.length ? [{ row: candidate, reasons }] : []);
    if (reasons.length) assert.strictEqual(result[0].row, candidate);
  });
}

test("preserves input order and does not mutate rows or evidence sets", () => {
  const first = row("vendor:0123456", { "Причина": "#12 #12" });
  const ignored = row("ignored", { "Other": "#12" });
  const last = row("last", { "Как снимать": "#23" });
  const rows = [first, ignored, last];
  const before = structuredClone(rows);
  const prNumbers = new Set([12, 23]);
  const commitShas = new Set([sha]);
  const result = findPossiblyRemovableRows(rows, { prNumbers, commitShas });
  assert.deepEqual(result, [
    { row: first, reasons: [reason(12), commitReason("0123456")] },
    { row: last, reasons: [reason(23)] },
  ]);
  assert.strictEqual(result[0].row, first);
  assert.strictEqual(result[1].row, last);
  assert.deepEqual(rows, before);
  assert.deepEqual([...prNumbers], [12, 23]);
  assert.deepEqual([...commitShas], [sha]);
});

test("empty rows produce no evidence", () => {
  assert.deepEqual(run([], [12], [sha]), []);
});
