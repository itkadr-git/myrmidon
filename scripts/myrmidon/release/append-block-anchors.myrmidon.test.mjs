import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldAppendBlock } from "./collect-fragments.mjs";

describe("append-block anchors", () => {
  it("appends prose at the end of the selected section without losing its neighbors", () => {
    const input = "# Document\n\n## First\n\nFirst text.\n\n## Target\n\nOriginal text.\n\nMore text.\n\n## Next\n\nNext text.\n";
    const expected = "# Document\n\n## First\n\nFirst text.\n\n## Target\n\nOriginal text.\n\nMore text.\n\nNew paragraph.\nSecond line.\n\n## Next\n\nNext text.\n";
    const options = { section: "Target", body: "New paragraph.\nSecond line." };
    assert.equal(foldAppendBlock(input, options), expected);
    assert.equal(foldAppendBlock(input, options), expected);
  });

  it("inserts rows after the last table row before trailing prose", () => {
    const input = "## Target\n\nIntro.\n\n| Name | Value |\n| --- | --- |\n| old | 1 |\n\nKeep this note.\n\n## Next\n\nUntouched.\n";
    const expected = "## Target\n\nIntro.\n\n| Name | Value |\n| --- | --- |\n| old | 1 |\n| new | 2 |\n| other | 3 |\n\nKeep this note.\n\n## Next\n\nUntouched.\n";
    const options = { section: "Target", body: "| new | 2 |\n| other | 3 |" };
    assert.equal(foldAppendBlock(input, options), expected);
    assert.equal(foldAppendBlock(input, options), expected);
  });

  it("inserts after an exact line and preserves a nonblank tail", () => {
    const input = "Before\nAnchor\nFollowing line\nLast line\n";
    const expected = "Before\nAnchor\n\nInserted\n\nFollowing line\nLast line\n";
    const options = { afterLine: "Anchor", body: "Inserted" };
    assert.equal(foldAppendBlock(input, options), expected);
    assert.equal(foldAppendBlock(input, options), expected);
  });

  it("inserts after a line at EOF", () => {
    const input = "Before\nAnchor";
    const options = { afterLine: "Anchor", body: "Inserted" };
    assert.equal(foldAppendBlock(input, options), "Before\nAnchor\n\nInserted");
    assert.equal(foldAppendBlock(input, options), "Before\nAnchor\n\nInserted");
  });

  it("rejects absent and ambiguous section anchors", () => {
    assert.throws(() => foldAppendBlock("## Other\nText\n", { section: "Target", body: "New" }), /no "## Target" section/);
    assert.throws(() => foldAppendBlock("## Target\nOne\n## Target\nTwo\n", { section: "Target", body: "New" }), /ambiguous/);
    assert.throws(() => foldAppendBlock("## Target\n| a |\n## Target\n| b |\n", { section: "Target", body: "| new |" }), /ambiguous/);
  });

  it("rejects absent and ambiguous after-line anchors", () => {
    assert.throws(() => foldAppendBlock("Other\n", { afterLine: "Anchor", body: "New" }), /matches 0 lines/);
    assert.throws(() => foldAppendBlock("Anchor\nText\nAnchor\n", { afterLine: "Anchor", body: "New" }), /matches 2 lines/);
  });

  it("honors an explicit section occurrence", () => {
    const input = "## Target\nFirst\n\n## Target\nSecond\n\n## Next\nEnd\n";
    const expected = "## Target\nFirst\n\n## Target\nSecond\n\nNew\n\n## Next\nEnd\n";
    assert.equal(foldAppendBlock(input, { section: "Target", occurrence: 2, body: "New" }), expected);
  });
});
