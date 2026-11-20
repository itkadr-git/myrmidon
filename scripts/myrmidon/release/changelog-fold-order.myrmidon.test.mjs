import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldChangelog } from "./collect-fragments.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

for (const heading of ["Unreleased", "Без выпуска"]) {
  describe(`foldChangelog order: ${heading}`, () => {
    const options = deepFreeze({
      version: "1.7.0",
      unreleasedHeading: heading,
      blocks: ["### A\n\n- block A", "### B\n\n- block B"],
    });
    const unreleased = `## ${heading}\n\n### U\n\n- unreleased entry\n\n`;
    const target = "## 1.7.0\n\n### T\n\n- target entry\n\n";
    const old = "## 1.6.0\n\n- old-version sentinel\n";
    const empty = `## ${heading}\n\n`;
    const folded = "## 1.7.0\n\n### U\n\n- unreleased entry\n\n### A\n\n- block A\n\n### B\n\n- block B\n\n### T\n\n- target entry\n\n";
    const fresh = "## 1.7.0\n\n### U\n\n- unreleased entry\n\n### A\n\n- block A\n\n### B\n\n- block B\n\n";

    it("prepends U, A, B to a target after unreleased", () => {
      assert.equal(foldChangelog(`# Log\n\n${unreleased}${target}${old}`, options), `# Log\n\n${empty}${folded}${old}`);
    });
    it("prepends U, A, B to a target before unreleased", () => {
      assert.equal(foldChangelog(`# Log\n\n${target}${unreleased}${old}`, options), `# Log\n\n${folded}${empty}${old}`);
    });
    it("creates a missing target with U, A, B", () => {
      assert.equal(foldChangelog(`# Log\n\n${unreleased}${old}`, options), `# Log\n\n${empty}${fresh}${old}`);
    });
    it("keeps U, A, B in unreleased when version is null", () => {
      const preview = deepFreeze({ ...options, version: null });
      const expected = `# Log\n\n## ${heading}\n\n### U\n\n- unreleased entry\n\n### A\n\n- block A\n\n### B\n\n- block B\n\n${old}`;
      assert.equal(foldChangelog(`# Log\n\n${unreleased}${old}`, preview), expected);
    });
    it("rejects a missing unreleased section", () => {
      assert.throws(() => foldChangelog(`# Log\n\n${target}${old}`, options), {
        name: "Error",
        message: `changelog has no "## ${heading}" section`,
      });
    });
  });
}
