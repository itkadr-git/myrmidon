import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyLicense } from "./check-licenses.mjs";

const policy = { allowed: ["MIT", "Apache-2.0"], forbidden: ["GPL-*"] };

// Each row states the contract independently of the implementation.
const cases = [
  ["MIT", "allowed"],
  ["GPL-3.0-only", "forbidden"],
  ["MPL-2.0", "unknown"],
  ["MIT OR Apache-2.0", "allowed"],
  ["MIT OR GPL-3.0-only", "allowed"],
  ["MIT OR MPL-2.0", "allowed"],
  ["GPL-2.0-only OR GPL-3.0-only", "forbidden"],
  ["GPL-3.0-only OR MPL-2.0", "unknown"],
  ["MPL-2.0 OR ISC", "unknown"],
  ["MIT AND Apache-2.0", "allowed"],
  ["MIT AND GPL-3.0-only", "forbidden"],
  ["MIT AND MPL-2.0", "unknown"],
  ["GPL-2.0-only AND GPL-3.0-only", "forbidden"],
  ["GPL-3.0-only AND MPL-2.0", "forbidden"],
  ["MPL-2.0 AND ISC", "unknown"],
  ["MIT AND GPL-3.0-only OR Apache-2.0", "allowed"],
  ["MIT AND MPL-2.0 OR GPL-3.0-only", "unknown"],
  ["MIT AND GPL-3.0-only OR GPL-2.0-only", "forbidden"],
  ["  mit\tAnD  apache-2.0  oR gpl-3.0-only ", "allowed"],
  ["gPl-2.0-oNlY", "forbidden"],
  ["MIT-extra", "unknown"],
];

describe("license expression verdicts", () => {
  for (const [expression, expected] of cases) {
    it(`${expression.trim()} is ${expected}`, () => {
      assert.equal(classifyLicense(expression, policy), expected);
    });
  }

  for (const [operator, first, second, expected] of [
    ["OR", "MIT", "GPL-3.0-only", "allowed"],
    ["OR", "MIT", "MPL-2.0", "allowed"],
    ["OR", "GPL-3.0-only", "MPL-2.0", "unknown"],
    ["AND", "MIT", "GPL-3.0-only", "forbidden"],
    ["AND", "MIT", "MPL-2.0", "unknown"],
    ["AND", "GPL-3.0-only", "MPL-2.0", "forbidden"],
  ]) {
    it(`${operator} preserves ${expected} when operands are swapped`, () => {
      assert.equal(classifyLicense(`${first} ${operator} ${second}`, policy), expected);
      assert.equal(classifyLicense(`${second} ${operator} ${first}`, policy), expected);
    });
  }

  it("preserves verdict when alternatives and conjunctions are reordered", () => {
    assert.equal(classifyLicense("MIT AND MPL-2.0 OR GPL-3.0-only", policy), "unknown");
    assert.equal(classifyLicense("GPL-3.0-only OR MPL-2.0 AND MIT", policy), "unknown");
  });
});
