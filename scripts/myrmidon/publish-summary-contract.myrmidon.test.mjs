import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileForbiddenPatterns } from "./scan-diff.mjs";
import { scanForPublication } from "./publish-scan.mjs";

const value = ["fixture", "value"].join("-");
const assignment = ["password", value].join(": ");
const addresses = [[10, 20, 30, 40], [10, 20, 30, 41]].map((parts) => parts.join("."));
const pattern = ["samplehost", "\\d+"].join("-");
const match = ["samplehost", "42"].join("-");
const forbidden = compileForbiddenPatterns(["# fixture", pattern].join("\n"));
const lines = ["Opening text.", assignment, `Hosts: ${addresses.join(" and ")}`, `See ${match}.`, "Closing text."];
const expected = {
  allowed: false,
  lines: 5,
  findingCount: 4,
  byRule: [
    { rule: "secret-like assignment", count: 1 },
    { rule: "private address in 10/8", count: 2 },
    { rule: "forbidden pattern #2", count: 1 },
  ],
};
const cleanEmpty = { allowed: true, lines: 0, findingCount: 0, byRule: [] };

describe("publication summary contract", () => {
  for (const [name, input] of [["null", null], ["undefined", undefined], ["empty", ""]]) {
    it(`allows ${name} input with an empty summary`, () => {
      assert.deepEqual(scanForPublication(input, forbidden), cleanEmpty);
    });
  }

  it("allows clean multiline text with configured patterns", () => {
    assert.deepEqual(scanForPublication("Opening text.\nClosing text.", forbidden), {
      allowed: true, lines: 2, findingCount: 0, byRule: [],
    });
  });

  for (const [name, separator] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
    it(`summarizes mixed findings with ${name} line endings without exposing input`, () => {
      const text = lines.join(separator);
      const result = scanForPublication(text, forbidden);
      assert.deepEqual(result, expected);
      assert.equal(result.byRule.reduce((sum, entry) => sum + entry.count, 0), result.findingCount);
      const serialized = JSON.stringify(result);
      for (const sensitive of [text, assignment, value, ...addresses, match, pattern]) {
        assert.equal(serialized.includes(sensitive), false);
      }
    });
  }

  it("returns the same summary on repeated calls with the same patterns", () => {
    const text = lines.join("\n");
    assert.deepEqual(scanForPublication(text, forbidden), expected);
    assert.deepEqual(scanForPublication(text, forbidden), expected);
  });

  it("does not report a custom match without configured patterns", () => {
    assert.deepEqual(scanForPublication(`See ${match}.`), {
      allowed: true, lines: 1, findingCount: 0, byRule: [],
    });
  });
});
