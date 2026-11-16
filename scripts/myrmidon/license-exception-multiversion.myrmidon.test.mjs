import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate, flattenReport } from "./check-licenses.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const report = deepFreeze({
  "GPL-3.0-only": [
    { name: "pkg-next", versions: ["1.0.0"], license: "" },
    { name: "pkg", versions: ["2.0.0", "1.0.0"] },
    { name: "pkg-empty", versions: [] },
    { name: "pkg-missing" },
    { name: "pkg-allowed", versions: ["1.0.0"], license: "MIT" },
  ],
  "MPL-2.0": [
    { name: "pkg", versions: ["3.0.0"] },
    { name: "pkg", versions: ["4.0.0"], license: "gpl-3.0-only" },
    { name: "pkg", versions: ["5.0.0"], license: "GPL-3.0-only" },
  ],
});

const policy = deepFreeze({
  allowed: ["MIT"],
  forbidden: ["GPL-3.0-only"],
  exceptions: [
    { name: "pkg", license: "GPL-3.0-only", reason: "Reviewed upstream license" },
    { name: "pkg-allowed", license: "MIT", reason: "Already allowed license" },
    { name: "pkg-absent", license: "GPL-3.0-only", reason: "Package is absent" },
  ],
});

describe("license exception multiversion contract", () => {
  it("flattens groups, overrides, missing and empty versions in exact order", () => {
    assert.deepEqual(flattenReport(report), [
      { name: "pkg", version: "1.0.0", license: "GPL-3.0-only" },
      { name: "pkg", version: "2.0.0", license: "GPL-3.0-only" },
      { name: "pkg", version: "3.0.0", license: "MPL-2.0" },
      { name: "pkg", version: "4.0.0", license: "gpl-3.0-only" },
      { name: "pkg", version: "5.0.0", license: "GPL-3.0-only" },
      { name: "pkg-allowed", version: "1.0.0", license: "MIT" },
      { name: "pkg-missing", version: "", license: "GPL-3.0-only" },
      { name: "pkg-next", version: "1.0.0", license: "GPL-3.0-only" },
    ]);
  });

  it("returns no rows for a null report", () => {
    assert.deepEqual(flattenReport(null), []);
  });

  it("matches exceptions by exact name and reported license across versions without mutating inputs", () => {
    const reportBefore = structuredClone(report);
    const policyBefore = structuredClone(policy);
    assert.deepEqual(evaluate(report, policy), {
      violations: [
        { name: "pkg", version: "3.0.0", license: "MPL-2.0", verdict: "unknown" },
        { name: "pkg", version: "4.0.0", license: "gpl-3.0-only", verdict: "forbidden" },
        { name: "pkg-missing", version: "", license: "GPL-3.0-only", verdict: "forbidden" },
        { name: "pkg-next", version: "1.0.0", license: "GPL-3.0-only", verdict: "forbidden" },
      ],
      excepted: [
        { name: "pkg", version: "1.0.0", license: "GPL-3.0-only", reason: "Reviewed upstream license" },
        { name: "pkg", version: "2.0.0", license: "GPL-3.0-only", reason: "Reviewed upstream license" },
        { name: "pkg", version: "5.0.0", license: "GPL-3.0-only", reason: "Reviewed upstream license" },
      ],
      unusedExceptions: [
        { name: "pkg-allowed", license: "MIT", reason: "Already allowed license" },
        { name: "pkg-absent", license: "GPL-3.0-only", reason: "Package is absent" },
      ],
    });
    assert.deepEqual(report, reportBefore);
    assert.deepEqual(policy, policyBefore);
  });
});
