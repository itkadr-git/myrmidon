import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bankPath, makeBatches } from "./split-banks.mjs";

describe("export batch boundaries", () => {
  it("returns no batches for empty input", () => {
    assert.deepEqual(makeBatches([], 1, 1), []);
  });

  it("splits every ID when maxCount is one", () => {
    assert.deepEqual(makeBatches(["a", "b", "c"], 1, 1000), [["a"], ["b"], ["c"]]);
  });

  it("keeps the exact count boundary together", () => {
    assert.deepEqual(makeBatches(["a", "b"], 2, 1000), [["a", "b"]]);
  });

  it("splits the first ID beyond the count boundary", () => {
    assert.deepEqual(makeBatches(["a", "b", "c"], 2, 1000), [["a", "b"], ["c"]]);
  });

  // Each one-character ASCII ID costs 12 + 1 + 1 = 14 query characters.
  it("keeps ASCII IDs at the exact query budget", () => {
    assert.deepEqual(makeBatches(["a", "b"], 10, 28), [["a", "b"]]);
  });

  it("splits ASCII IDs one character over the query budget", () => {
    assert.deepEqual(makeBatches(["a", "b"], 10, 27), [["a"], ["b"]]);
  });

  for (const [name, id, budget] of [
    ["space", "a b", 32],
    ["slash", "a/b", 32],
    ["ampersand", "a&b", 32],
    ["question mark", "a?b", 32],
    ["Unicode", "\u00e9", 33],
  ]) {
    it(`counts encoded ${name} at the exact budget`, () => {
      assert.deepEqual(makeBatches(["x", id], 10, budget), [["x", id]]);
    });
    it(`splits encoded ${name} one character over budget`, () => {
      assert.deepEqual(makeBatches(["x", id], 10, budget - 1), [["x"], [id]]);
    });
  }

  it("keeps an oversized ID alone without producing empty batches", () => {
    assert.deepEqual(makeBatches(["a", "oversized", "b"], 10, 14), [["a"], ["oversized"], ["b"]]);
  });

  it("preserves order, duplicate IDs, and the input array", () => {
    const ids = Object.freeze(["b", "a", "b", "c", "a"]);
    assert.deepEqual(makeBatches(ids, 2, 1000), [["b", "a"], ["b", "c"], ["a"]]);
    assert.deepEqual(ids, ["b", "a", "b", "c", "a"]);
  });
});

describe("bank paths", () => {
  it("encodes reserved bank ID characters once and keeps the suffix unchanged", () => {
    assert.equal(
      bankPath("bank/a?b#c d", "/document-transfer/export?document_id=x%2Fy&raw=1"),
      "/v1/default/banks/bank%2Fa%3Fb%23c%20d/document-transfer/export?document_id=x%2Fy&raw=1",
    );
  });

  it("uses an empty suffix by default", () => {
    assert.equal(bankPath("bank/a"), "/v1/default/banks/bank%2Fa");
  });
});
