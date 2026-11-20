import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanLine, scanText } from "./scan-text.mjs";

const github = (prefix, length) => [prefix, "A".repeat(length)].join("_");
const other = (length) => ["sk", "B".repeat(length)].join("-");
const telegram = (digits, tail) => ["1".repeat(digits), "C".repeat(tail)].join(":");

function check(text, expectedRules, token = text) {
  const findings = scanLine(text, 7);
  assert.deepEqual(findings, expectedRules.map((rule) => ({ line: 7, rule })));
  assert.equal(JSON.stringify(findings).includes(token), false);
}

describe("publication token thresholds", () => {
  for (const prefix of ["gho", "ghu", "ghs", "ghr"]) {
    it(`checks ${prefix} at 19, 20 and 21 characters`, () => {
      for (const [length, rules] of [[19, []], [20, ["github token"]], [21, ["github token"]]]) {
        check(github(prefix, length), rules);
      }
    });
  }

  it("checks the other token prefix at 7, 8 and 9 characters", () => {
    for (const [length, rules] of [[7, []], [8, ["other token prefix"]], [9, ["other token prefix"]]]) {
      check(other(length), rules);
    }
  });

  it("checks Telegram digit counts at 7, 8, 10 and 11", () => {
    for (const [length, rules] of [[7, []], [8, ["telegram bot token"]], [10, ["telegram bot token"]], [11, []]]) {
      check(telegram(length, 35), rules);
    }
  });

  it("checks Telegram tail lengths at 34, 35 and 36", () => {
    for (const [length, rules] of [[34, []], [35, ["telegram bot token"]], [36, []]]) {
      check(telegram(8, length), rules);
    }
  });

  it("distinguishes alphanumeric prefixes from punctuation", () => {
    for (const [token, rule] of [[github("gho", 20), "github token"], [other(8), "other token prefix"], [telegram(10, 35), "telegram bot token"]]) {
      for (const prefix of ["a", "5"]) check(prefix + token, [], token);
      for (const prefix of [" ", "(", "."]) check(prefix + token, [rule], token);
    }
  });

  it("rejects Telegram alphanumeric tail extensions but accepts punctuation", () => {
    const token = telegram(8, 35);
    for (const suffix of ["a", "5", "_", "-"]) check(token + suffix, [], token);
    for (const suffix of [" ", ")", "."]) check(token + suffix, ["telegram bot token"], token);
  });

  it("keeps ordinary words clean and reports exact multiline findings", () => {
    for (const word of ["risk-assessment", "disk-pressure", "task-scheduler", "ordinary words"]) {
      assert.deepEqual(scanText(word), []);
    }
    const token = github("ghu", 20);
    const findings = scanText(["clean text", token, "another clean line"].join("\n"));
    assert.deepEqual(findings, [{ line: 2, rule: "github token" }]);
    assert.equal(JSON.stringify(findings).includes(token), false);
  });
});
