import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractPrNumbers, findPossiblyRemovableRows } from "./lib.mjs";

describe("removal evidence contract", () => {
  it("extracts and deduplicates only parenthesized PR numbers from subjects", () => {
    assert.deepEqual([...extractPrNumbers([
      "fix: first (#42)",
      "fix: again (#42), and (#7)",
      "fix: bare #99 and malformed (#12",
      "fix: other (#7)",
    ])], [42, 7]);
    assert.deepEqual([...extractPrNumbers(["bare #42", "(#x)", "no reference"])], []);
  });

  it("uses only removal and reason columns, deduplicates PR evidence, and preserves rows", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const rows = [
      { id: "ignored", cells: { PR: "#42", "Other": "#7", "Как снимать": "#99" } },
      { id: "vendor:abcdef0", cells: { "Как снимать": "merge #42", "Причина": "upstream #42" } },
      { id: "reason-only", cells: { "Причина": "upstream #7" } },
      { id: "unrelated", cells: { "Как снимать": "#99" } },
      { id: "removal-only", cells: { "Как снимать": "merge #42" } },
    ];
    const before = structuredClone(rows);
    const result = findPossiblyRemovableRows(rows, {
      prNumbers: extractPrNumbers(["fix (#42)", "fix (#7)"]),
      commitShas: [sha],
    });
    assert.deepEqual(result, [
      { row: rows[1], reasons: ["vendor #42 is in the range", "commit abcdef0 is in the range"] },
      { row: rows[2], reasons: ["vendor #7 is in the range"] },
      { row: rows[4], reasons: ["vendor #42 is in the range"] },
    ]);
    assert.equal(result[0].row, rows[1]);
    assert.equal(result[1].row, rows[2]);
    assert.equal(result[2].row, rows[4]);
    assert.deepEqual(rows, before);
  });

  it("matches 7- and 40-character SHA prefixes but rejects neighboring and invalid IDs", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const rows = [
      { id: "vendor:abcdef0", cells: {} },
      { id: `vendor:${sha}`, cells: {} },
      { id: "vendor:abcdef1", cells: {} },
      { id: "vendor:abcdef", cells: {} },
      { id: `vendor:${sha}0`, cells: {} },
      { id: "vendor:abcdefg", cells: {} },
    ];
    assert.deepEqual(findPossiblyRemovableRows(rows, { prNumbers: new Set(), commitShas: [sha] }), [
      { row: rows[0], reasons: ["commit abcdef0 is in the range"] },
      { row: rows[1], reasons: [`commit ${sha} is in the range`] },
    ]);
    assert.deepEqual(findPossiblyRemovableRows(rows, { prNumbers: new Set(), commitShas: [] }), []);
  });
});
