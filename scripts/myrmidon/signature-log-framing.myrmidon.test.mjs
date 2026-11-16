import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGitLog } from "./ai-signature-scan.mjs";

const FIELD = "\u001f";
const RECORD = "\u001e";
const first = { sha: "a".repeat(40), authorName: "Ada", committerName: "Bea", message: "first subject\n\nfirst body\n" };
const second = { sha: "b".repeat(40), authorName: "Cy", committerName: "Dee", message: `second subject\nline ${FIELD}inside\nlast line\n` };
const third = { sha: "c".repeat(40), authorName: "Eli", committerName: "Fay", message: "third subject\n" };
const record = ({ sha, authorName, committerName, message }) =>
  `${sha}${FIELD}${authorName}${FIELD}${committerName}${FIELD}${message}${RECORD}`;

describe("git log framing contract", () => {
  it("returns no commits for an empty stream", () => {
    assert.deepEqual(parseGitLog(""), []);
  });

  it("parses a single complete record", () => {
    assert.deepEqual(parseGitLog(record(first)), [first]);
  });

  it("preserves order, leading record separators and FIELD in a multiline body", () => {
    const raw = `\n${record(first)}\n\n${record(second)}\n${record(third)}\n`;
    assert.deepEqual(parseGitLog(raw), [first, second, third]);
  });

  it("does not mix records between consecutive calls", () => {
    assert.deepEqual(parseGitLog(record(first) + "\n" + record(second)), [first, second]);
    assert.deepEqual(parseGitLog(record(third)), [third]);
    assert.deepEqual(parseGitLog(""), []);
  });
});
