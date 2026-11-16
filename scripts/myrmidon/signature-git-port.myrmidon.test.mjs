import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCommits } from "./ai-signature-scan.mjs";

const range = "base ref..head ref";
const first = "a".repeat(40);
const second = "b".repeat(40);
const records = `${first}\x1fAlice\x1fBob\x1fSubject\n\nBody\x1fextra\n\x1e\n${second}\x1fCarol\x1fDan\x1fSecond\n\x1e\n`;
const expected = [
  { sha: first, authorName: "Alice", committerName: "Bob", message: "Subject\n\nBody\x1fextra\n" },
  { sha: second, authorName: "Carol", committerName: "Dan", message: "Second\n" },
];

describe("readCommits git port", () => {
  it("passes the exact git command and parses multiple records", () => {
    const calls = [];
    const result = readCommits(range, (...args) => {
      calls.push(args);
      return { status: 0, stdout: records };
    });
    assert.deepEqual(calls, [[
      "git",
      ["log", "--format=%H\x1f%an\x1f%cn\x1f%B\x1e", range],
      { encoding: "utf8", maxBuffer: 67108864 },
    ]]);
    assert.deepEqual(result, expected);
  });

  it("returns an empty list for empty successful output", () => {
    assert.deepEqual(readCommits(range, () => ({ status: 0, stdout: "" })), []);
  });

  it("rejects spawn errors and nonzero or missing status even with valid stdout", () => {
    for (const response of [
      { status: 0, error: new Error("spawn failed"), stdout: records },
      { status: 1, stdout: records },
      { status: 128, stdout: records },
      { status: null, stdout: records },
    ]) {
      assert.throws(() => readCommits(range, () => response), {
        message: `git log ${range} failed`,
      });
    }
  });

  it("does not retain results across success, failure and success", () => {
    const responses = [
      { status: 0, stdout: records },
      { status: 1, stdout: records },
      { status: 0, stdout: `${second}\x1fCarol\x1fDan\x1fFresh\n\x1e\n` },
    ];
    const git = () => responses.shift();
    assert.deepEqual(readCommits(range, git), expected);
    assert.throws(() => readCommits(range, git), { message: `git log ${range} failed` });
    assert.deepEqual(readCommits(range, git), [
      { sha: second, authorName: "Carol", committerName: "Dan", message: "Fresh\n" },
    ]);
    assert.equal(responses.length, 0);
  });
});
