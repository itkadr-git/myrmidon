import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVerdictLines } from "./review-approve-label.mjs";

const repo = "owner/name";
const marker = (prNumber, outcome, head = null, line = 0) => ({ prNumber, outcome, head, line });

for (const word of ["APPROVE", "APPROVED", "LGTM"]) {
  test(`recognizes ${word}`, () => {
    assert.deepEqual(parseVerdictLines(`VERDICT #12: ${word}`, repo), [marker(12, "approve")]);
  });
}

for (const word of ["RETURN", "RETURNED", "REWORK", "DEFERRED", "REJECT", "REJECTED", "BLOCK", "BLOCKED", "CHANGES REQUESTED", "REQUEST CHANGES", "SUPERSEDED"]) {
  test(`recognizes refusal ${word}`, () => {
    assert.deepEqual(parseVerdictLines(`VERDICT #12: ${word}`, repo), [marker(12, "refuse")]);
  });
}

test("recognizes the Cyrillic marker", () => {
  assert.deepEqual(parseVerdictLines("ВЕРДИКТ #42: APPROVED", repo), [marker(42, "approve")]);
});

test("approval and refusal together are unclear", () => {
  assert.deepEqual(parseVerdictLines("VERDICT #12: APPROVE but REQUEST CHANGES", repo), [marker(12, "unclear")]);
});

test("distinct PRs on one line are unclear for both", () => {
  assert.deepEqual(parseVerdictLines("VERDICT #12 and #13: APPROVE", repo), [marker(12, "unclear"), marker(13, "unclear")]);
});

test("repeating a PR does not duplicate it or make it unclear", () => {
  assert.deepEqual(parseVerdictLines("VERDICT #12 and owner/name#12: APPROVE", repo), [marker(12, "approve")]);
});

test("ignores a foreign repository while matching repository names case-insensitively", () => {
  assert.deepEqual(parseVerdictLines("VERDICT other/repo#99 and OWNER/NAME#12: APPROVE", repo), [marker(12, "approve")]);
  assert.deepEqual(parseVerdictLines("VERDICT other/repo#99: APPROVE", repo), []);
});

test("ignores text without a verdict marker", () => {
  assert.deepEqual(parseVerdictLines("APPROVE PR #12", repo), []);
});

test("preserves zero-based line indices with CRLF", () => {
  assert.deepEqual(parseVerdictLines("intro\r\nVERDICT #12: APPROVE\r\n\r\nVERDICT #13: RETURN", repo), [marker(12, "approve", null, 1), marker(13, "refuse", null, 3)]);
});

test("normalizes a seven-digit head to lowercase", () => {
  assert.deepEqual(parseVerdictLines("VERDICT #12: APPROVE head ABCD123", repo), [marker(12, "approve", "abcd123")]);
});

test("normalizes a forty-digit head to lowercase", () => {
  assert.deepEqual(parseVerdictLines("VERDICT #12: APPROVE head ABCDEF0123456789ABCDEF0123456789ABCDEF01", repo), [marker(12, "approve", "abcdef0123456789abcdef0123456789abcdef01")]);
});

test("returns null when no head is named", () => {
  assert.deepEqual(parseVerdictLines("VERDICT #12: APPROVE", repo), [marker(12, "approve", null)]);
});
