import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseOf, previousMinorPatch, rcOf } from "./release-body.mjs";

describe("release version boundaries", () => {
  it("parses final and candidate versions, including rc.0", () => {
    const cases = [
      ["0.0.0", "0.0.0", null],
      ["1.7.3", "1.7.3", null],
      ["12.34.56", "12.34.56", null],
      ["1.7.3-rc.0", "1.7.3", 0],
      ["1.7.3-rc.1", "1.7.3", 1],
      ["12.34.56-rc.42", "12.34.56", 42],
    ];
    for (const [version, base, rc] of cases) {
      assert.equal(baseOf(version), base, version);
      assert.equal(rcOf(version), rc, version);
    }
  });

  it("rejects prefixes, suffixes and incomplete versions", () => {
    const invalid = [
      "", "1", "1.7", "1.7.", ".7.3", "1..3", "v1.7.3",
      "myr-v1.7.3", " 1.7.3", "1.7.3 ", "1.7.3-extra",
      "1.7.3+build", "1.7.3-rc", "1.7.3-rc.", "1.7.3-rc.-1",
      "1.7.3-rc.1-extra", "1.7.3.4", "1.7.3-RC.1",
    ];
    for (const version of invalid) {
      assert.equal(baseOf(version), null, version);
      assert.equal(rcOf(version), null, version);
      assert.equal(previousMinorPatch(version), null, version);
    }
  });

  it("selects the preceding patch or minor and stops at the major floor", () => {
    const cases = [
      ["1.7.3", "1.7.2"],
      ["1.7.1", "1.7.0"],
      ["1.7.0", "1.6.0"],
      ["2.1.0", "2.0.0"],
      ["2.0.1", "2.0.0"],
      ["2.0.0", null],
      ["0.0.0", null],
    ];
    for (const [final, previous] of cases) {
      assert.equal(previousMinorPatch(final), previous, final);
      for (const suffix of ["-rc.0", "-rc.1", "-rc.12"]) {
        const candidate = final + suffix;
        assert.equal(baseOf(candidate), final, candidate);
        assert.equal(previousMinorPatch(candidate), previous, candidate);
      }
    }
  });
});
