import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeVersionSections } from "./collect-fragments.mjs";

test("merges separated target sections without changing unrelated bytes", () => {
  const preamble = "# Release notes\n\nPreamble sentinel:  spaces  stay.\n\n";
  const first = "## 1.7.0\n\n### First\n\n- alpha\n\n";
  const other = "## 1.6.9\n\n### Other\n\n- sentinel  one\n\n";
  const empty = "## 1.7.0\n\n";
  const similar = "## 1.7.01\n\n- numeric sentinel\n\n## 1.7.0-rc.1\n\n- prerelease sentinel\n\n";
  const last = "## 1.7.0\n\n### Last\n\n- omega\n\n";
  const suffix = "## 1.6.8\n\n- final sentinel\n";
  const input = preamble + first + other + empty + similar + last + suffix;
  const expected = preamble + "## 1.7.0\n\n### First\n\n- alpha\n\n### Last\n\n- omega\n\n" + other + similar + suffix;

  const merged = mergeVersionSections(input, "1.7.0");
  assert.equal(merged, expected);
  assert.equal(merged.split("\n").filter((line) => line === "## 1.7.0").length, 1);
  assert.equal(mergeVersionSections(merged, "1.7.0"), expected);
});

test("zero or one exact target section is byte-identical", () => {
  const withoutTarget = "# Notes\n\n## 1.7.01\n\n- retain  spaces\n\n## 1.7.0-rc.1\n\n- retain prerelease\n";
  const withTarget = "# Notes\n\n## 1.7.0-rc.1\n\n- rc\n\n## 1.7.0\n\n- only target\n\n## 1.7.01\n\n- other\n";
  assert.equal(mergeVersionSections(withoutTarget, "1.7.0"), withoutTarget);
  assert.equal(mergeVersionSections(withTarget, "1.7.0"), withTarget);
});
