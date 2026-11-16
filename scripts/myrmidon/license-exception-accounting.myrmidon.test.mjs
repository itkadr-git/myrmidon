import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate } from "./check-licenses.mjs";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const exception = { name: "alpha", license: "GPL-3.0-only", reason: "Approved for alpha" };
const other = { name: "zeta", license: "MPL-2.0", reason: "Approved for zeta" };
const policy = freeze({ allowed: ["MIT"], forbidden: ["GPL*"], exceptions: [other, exception] });

function check(report, expected, selectedPolicy = policy) {
  assert.deepStrictEqual(evaluate(freeze(report), selectedPolicy), expected);
}

describe("license exception accounting", () => {
  it("uses one exact exception for both versions and preserves sorted rows", () => {
    check({ "GPL-3.0-only": [{ name: "alpha", versions: ["2.0.0", "1.0.0"] }] }, {
      violations: [],
      excepted: [
        { name: "alpha", version: "1.0.0", license: "GPL-3.0-only", reason: "Approved for alpha" },
        { name: "alpha", version: "2.0.0", license: "GPL-3.0-only", reason: "Approved for alpha" },
      ],
      unusedExceptions: [other],
    });
  });

  it("does not match the name alone", () => {
    check({ "MPL-2.0": [{ name: "alpha", versions: ["1"] }] }, {
      violations: [{ name: "alpha", version: "1", license: "MPL-2.0", verdict: "unknown" }],
      excepted: [], unusedExceptions: [other, exception],
    });
  });

  it("does not match the license alone", () => {
    check({ "GPL-3.0-only": [{ name: "beta", versions: ["1"] }] }, {
      violations: [{ name: "beta", version: "1", license: "GPL-3.0-only", verdict: "forbidden" }],
      excepted: [], unusedExceptions: [other, exception],
    });
  });

  it("requires an exact license case for exceptions", () => {
    check({ "gpl-3.0-only": [{ name: "alpha", versions: ["1"] }] }, {
      violations: [{ name: "alpha", version: "1", license: "gpl-3.0-only", verdict: "forbidden" }],
      excepted: [], unusedExceptions: [other, exception],
    });
  });

  it("does not consume an exception for an allowed license", () => {
    const allowedException = { name: "alpha", license: "MIT", reason: "Previously approved" };
    const selectedPolicy = freeze({ allowed: ["MIT"], forbidden: ["GPL*"], exceptions: [allowedException] });
    check({ MIT: [{ name: "alpha", versions: ["1"] }] }, {
      violations: [], excepted: [], unusedExceptions: [allowedException],
    }, selectedPolicy);
  });

  it("accepts a policy without exceptions", () => {
    const selectedPolicy = freeze({ allowed: ["MIT"], forbidden: ["GPL*"] });
    check({ "GPL-3.0-only": [{ name: "alpha", versions: ["1"] }] }, {
      violations: [{ name: "alpha", version: "1", license: "GPL-3.0-only", verdict: "forbidden" }],
      excepted: [], unusedExceptions: [],
    }, selectedPolicy);
  });

  it("keeps exception usage independent across successive reports", () => {
    check({ "GPL-3.0-only": [{ name: "alpha", versions: ["1"] }] }, {
      violations: [],
      excepted: [{ name: "alpha", version: "1", license: "GPL-3.0-only", reason: "Approved for alpha" }],
      unusedExceptions: [other],
    });
    check({ "MPL-2.0": [{ name: "zeta", versions: ["3"] }] }, {
      violations: [],
      excepted: [{ name: "zeta", version: "3", license: "MPL-2.0", reason: "Approved for zeta" }],
      unusedExceptions: [exception],
    });
    check({}, { violations: [], excepted: [], unusedExceptions: [other, exception] });
  });

  it("sorts mixed violations and excepted rows and retains exception order", () => {
    const unused = { name: "missing", license: "MPL-2.0", reason: "No longer present" };
    const selectedPolicy = freeze({ allowed: ["MIT"], forbidden: ["GPL*"], exceptions: [unused, other, exception] });
    check({
      "MPL-2.0": [{ name: "zeta", versions: ["2"] }, { name: "beta", versions: ["2", "1"] }],
      "GPL-3.0-only": [{ name: "gamma", versions: ["1"] }, { name: "alpha", versions: ["1"] }],
    }, {
      violations: [
        { name: "beta", version: "1", license: "MPL-2.0", verdict: "unknown" },
        { name: "beta", version: "2", license: "MPL-2.0", verdict: "unknown" },
        { name: "gamma", version: "1", license: "GPL-3.0-only", verdict: "forbidden" },
      ],
      excepted: [
        { name: "alpha", version: "1", license: "GPL-3.0-only", reason: "Approved for alpha" },
        { name: "zeta", version: "2", license: "MPL-2.0", reason: "Approved for zeta" },
      ],
      unusedExceptions: [unused],
    }, selectedPolicy);
  });
});
