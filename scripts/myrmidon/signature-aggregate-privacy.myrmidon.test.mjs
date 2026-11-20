import assert from "node:assert/strict";
import { it } from "node:test";
import { main } from "./ai-signature-scan.mjs";

const assistant = ["Cla", "ude"].join("");
const trailer = ["Co-Authored", "By"].join("-") + `: ${assistant} <person@example.org>`;
const banner = ["Generated", "with", assistant, "Code"].join(" ");
const sentinel = "orchard-marble-private-content";
const allowedSha = "a".repeat(40);
const rejectedSha = "b".repeat(40);
const commit = (sha, message) => ({ sha, message, authorName: "Human", committerName: "Human" });

function capture(commits, stdin, allowedShas = new Set()) {
  const logs = [];
  const errors = [];
  const ranges = [];
  return {
    logs, errors, ranges,
    io: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      readCommits: (range) => { ranges.push(range); return commits; },
      stdin, allowedShas,
    },
  };
}

function assertPrivate(result, privateValues) {
  const output = [...result.logs, ...result.errors].join("\n");
  for (const value of privateValues) assert.equal(output.includes(value), false, "output exposed private input");
}

it("aggregates non-allowlisted commit and stdin findings without leaking input", () => {
  const allowedMessage = `${sentinel} allowed\n${trailer}`;
  const rejectedMessage = `${sentinel} rejected\n${banner}`;
  const stdin = `${sentinel} pr\n${trailer}\n${banner}`;
  const result = capture([commit(allowedSha, allowedMessage), commit(rejectedSha, rejectedMessage)], stdin, new Set([allowedSha]));
  assert.equal(main(["--commits", "base..head"], result.io), 1);
  assert.deepEqual(result.ranges, ["base..head"]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.logs, [
    "ai-signature: 3 finding(s)",
    "  commit bbbbbbbbbb: ai-generated-banner",
    "  pr-text: ai-co-authored-by",
    "  pr-text: ai-generated-banner",
    "Remove the AI signature (trailer or banner) and set the author to the repository identity; do not rewrite main.",
  ]);
  assertPrivate(result, [allowedMessage, rejectedMessage, stdin, allowedSha, rejectedSha, sentinel]);
});

it("counts clean commits and stays clean on a repeated call", () => {
  const messages = [`${sentinel} first`, `${sentinel} second`];
  const result = capture([commit(allowedSha, messages[0]), commit(rejectedSha, messages[1])], `${sentinel} clean text`);
  assert.equal(main(["--commits", "base..head"], result.io), 0);
  assert.equal(main(["--commits", "base..head"], result.io), 0);
  assert.deepEqual(result.ranges, ["base..head", "base..head"]);
  assert.deepEqual(result.logs, ["ai-signature: clean (2 commit(s) checked)", "ai-signature: clean (2 commit(s) checked)"]);
  assert.deepEqual(result.errors, []);
  assertPrivate(result, [...messages, `${sentinel} clean text`, allowedSha, rejectedSha, sentinel]);
});

it("scans text without reading commits when no range is supplied", () => {
  const stdin = `${sentinel} text only\n${trailer}`;
  const result = capture([], stdin);
  assert.equal(main([], result.io), 1);
  assert.deepEqual(result.ranges, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.logs, [
    "ai-signature: 1 finding(s)",
    "  pr-text: ai-co-authored-by",
    "Remove the AI signature (trailer or banner) and set the author to the repository identity; do not rewrite main.",
  ]);
  assertPrivate(result, [stdin, sentinel]);
  const clean = capture([], `${sentinel} clean`);
  assert.equal(main([], clean.io), 0);
  assert.deepEqual(clean.ranges, []);
  assert.deepEqual(clean.logs, ["ai-signature: clean (0 commit(s) checked, text only)"]);
  assert.deepEqual(clean.errors, []);
  assertPrivate(clean, [`${sentinel} clean`, sentinel]);
});
