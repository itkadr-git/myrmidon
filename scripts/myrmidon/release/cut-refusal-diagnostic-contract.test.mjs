import assert from "node:assert/strict";
import test from "node:test";
import { formatRefusal } from "./cut-rc.mjs";

const tag = "myr-v1.7.0-rc.25";
const bypass = 'Bypass requires: --override "reason" --journal OPE-NNNN (the bypass is recorded on the board).';
const hard = "Not bypassable: fix the repository/CI problem and retry (an override covers stale board state only).";

const cases = [
  { name: "empty violations and no CI problem", violations: [], ciProblem: "", detail: "" },
  { name: "violations without CI problem", violations: ["open task OPE-102", "unmerged PR #3001", "open task OPE-102"], ciProblem: "", detail: "Violations:\n  - open task OPE-102\n  - unmerged PR #3001\n  - open task OPE-102\n" },
  { name: "CI problem without violations", violations: [], ciProblem: "build=failure", detail: "CI: build=failure\n" },
  { name: "violations and CI problem", violations: ["open task OPE-102", "unmerged PR #3001", "open task OPE-102"], ciProblem: "build=failure", detail: "Violations:\n  - open task OPE-102\n  - unmerged PR #3001\n  - open task OPE-102\nCI: build=failure\n" },
];

for (const scenario of cases) {
  for (const mode of ["default", "true", "false"]) {
    test(`formatRefusal: ${scenario.name}, overridable=${mode}`, () => {
      const input = { tag, violations: [...scenario.violations], ciProblem: scenario.ciProblem };
      if (mode !== "default") input.overridable = mode === "true";
      const before = structuredClone(input);
      const actual = formatRefusal(input);
      assert.equal(actual, `RELEASE-CUT REFUSED: ${tag}\n\n${scenario.detail}\n${mode === "false" ? hard : bypass}`);
      assert.deepEqual(input, before);
    });
  }
}

test("negative control: an empty formatter cannot satisfy the contract", () => {
  const expected = `RELEASE-CUT REFUSED: ${tag}\n\n\n${bypass}`;
  assert.throws(() => assert.equal("", expected), assert.AssertionError);
  assert.equal(formatRefusal({ tag, violations: [], ciProblem: "" }), expected);
});
