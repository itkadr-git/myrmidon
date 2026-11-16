import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldReplaceRows } from "./collect-fragments.mjs";

const doc = [
  "# Settings",
  "",
  "## Twin",
  "| Key | Value |",
  "| --- | --- |",
  "| SHARED | first |",
  "| OTHER | first other |",
  "",
  "## Twin",
  "| Key | Value |",
  "| --- | --- |",
  "| BEFORE | keep  spaces  |",
  "| SHARED | second |",
  "| OTHER | second other |",
  "| AFTER | keep |",
  "",
  "## Elsewhere",
  "| SHARED | third |",
  "| OTHER | third other |",
  "end without newline",
].join("\n");

describe("foldReplaceRows section scope", () => {
  it("selects exactly the requested occurrence and preserves every other byte", () => {
    const actual = foldReplaceRows(doc, {
      section: "Twin",
      occurrence: 2,
      rows: "| SHARED | updated |",
    });
    assert.equal(actual, doc.replace("| SHARED | second |", "| SHARED | updated |"));
  });

  it("rejects an ambiguous key without a section", () => {
    assert.throws(
      () => foldReplaceRows(doc, { rows: "| SHARED | updated |" }),
      /row replacement for "SHARED" matches 3 rows, need exactly one/,
    );
  });

  it("rejects a missing key inside the selected section even if it exists elsewhere", () => {
    assert.throws(
      () => foldReplaceRows(doc, { section: "Elsewhere", rows: "| BEFORE | updated |" }),
      /row replacement for "BEFORE" matches 0 rows, need exactly one/,
    );
  });

  it("replaces multiple rows only in the selected section and preserves surrounding bytes", () => {
    const actual = foldReplaceRows(doc, {
      section: "Twin",
      occurrence: 2,
      rows: "| SHARED | new shared |\n| OTHER | new other |",
    });
    const expected = doc.replace(
      "| SHARED | second |\n| OTHER | second other |",
      "| SHARED | new shared |\n| OTHER | new other |",
    );
    assert.equal(actual, expected);
  });
});
