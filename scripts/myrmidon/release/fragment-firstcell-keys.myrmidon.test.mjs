import { test } from "node:test";
import assert from "node:assert/strict";
import { firstCell, foldReplaceRows } from "./collect-fragments.mjs";

test("firstCell extracts exact keys from ordinary and numbered rows", () => {
  assert.equal(firstCell("| alpha | old |"), "alpha");
  assert.equal(firstCell("  |  spaced key  | value |"), "spaced key");
  assert.equal(firstCell("240i| `FOO` | old |"), "`FOO`");
  assert.equal(firstCell("  7i| other | value |"), "other");
  assert.equal(firstCell("|   | value |"), "");
});

test("firstCell rejects lines without both row delimiters", () => {
  assert.equal(firstCell("no delimiter"), null);
  assert.equal(firstCell("| only one delimiter"), null);
  assert.equal(firstCell("240i| incomplete"), null);
  assert.equal(firstCell("240| key | value |"), null);
});

test("foldReplaceRows replaces a numbered matching row and preserves another key", () => {
  const doc = "## Section\n\n| Key | Value |\n| --- | --- |\n240i| `FOO` | old |\n| `BAR` | keep |\n";
  const out = foldReplaceRows(doc, { rows: "| `FOO` | new |", section: "Section" });
  assert.equal(out, "## Section\n\n| Key | Value |\n| --- | --- |\n| `FOO` | new |\n| `BAR` | keep |\n");
  assert.throws(
    () => foldReplaceRows(doc, { rows: "| `MISSING` | new |", section: "Section" }),
    /matches 0 rows, need exactly one/,
  );
});
