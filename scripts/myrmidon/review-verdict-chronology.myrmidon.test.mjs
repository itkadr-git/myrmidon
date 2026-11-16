import assert from "node:assert/strict";
import { test } from "node:test";
import { latestVerdicts } from "./review-approve-label.mjs";

const early = "2026-10-08T06:00:00Z";
const late = "2026-10-08T07:00:00Z";
const comment = (body, createdAt = early, extra = {}) => ({
  id: "c1", issueId: "i1", authorName: "adm-dev-review-8", body, createdAt, ...extra,
});
const result = (prNumber, outcome, at = early, extra = {}) => ({
  prNumber, outcome, head: null, line: 0, at: new Date(at), commentId: "c1", issueId: "i1", ...extra,
});
const single = (comments, expected, options) => assert.deepEqual(latestVerdicts(comments, options), new Map([[5, expected]]));

test("ignores a later verdict by another author", () => {
  single([comment("VERDICT #5: APPROVE"), comment("VERDICT #5: RETURN", late, { authorName: "adm-dev-eng-8" })], result(5, "approve"));
});
test("ignores null comments", () => {
  single([null, comment("VERDICT #5: APPROVE"), null], result(5, "approve"));
});
test("ignores invalid dates", () => {
  single([comment("VERDICT #5: APPROVE"), comment("VERDICT #5: RETURN", "not-a-date")], result(5, "approve"));
});
test("ignores missing dates", () => {
  single([comment("VERDICT #5: APPROVE"), { ...comment("VERDICT #5: RETURN"), createdAt: undefined }], result(5, "approve"));
});
test("later refusal cancels approval", () => {
  single([comment("VERDICT #5: APPROVE"), comment("VERDICT #5: RETURN", late, { id: "c2" })], result(5, "refuse", late, { commentId: "c2" }));
});
test("later unclear verdict cancels approval", () => {
  single([comment("VERDICT #5: APPROVE"), comment("VERDICT #5: APPROVE RETURN", late, { id: "c2" })], result(5, "unclear", late, { commentId: "c2" }));
});
test("older comment later in input does not win", () => {
  single([comment("VERDICT #5: RETURN", late, { id: "c2" }), comment("VERDICT #5: APPROVE")], result(5, "refuse", late, { commentId: "c2" }));
});
test("later line wins within a comment at the same time", () => {
  single([comment("VERDICT #5: APPROVE\nVERDICT #5: RETURN")], result(5, "refuse", early, { line: 1 }));
});
test("equal timestamp and line use later input comment", () => {
  single([comment("VERDICT #5: APPROVE"), comment("VERDICT #5: RETURN", early, { id: "c2" })], result(5, "refuse", early, { commentId: "c2" }));
});
test("equal timestamp uses line order across comments", () => {
  single([comment("note\nVERDICT #5: APPROVE"), comment("VERDICT #5: RETURN", early, { id: "c2" })], result(5, "approve", early, { line: 1 }));
});
test("verdicts for independent PRs do not overwrite one another", () => {
  const actual = latestVerdicts([comment("VERDICT #5: APPROVE"), comment("VERDICT #6: RETURN", late, { id: "c2", issueId: "i2" })]);
  assert.deepEqual(actual, new Map([[5, result(5, "approve")], [6, result(6, "refuse", late, { commentId: "c2", issueId: "i2" })]]));
});
test("custom reviewer pattern selects only its authors", () => {
  single([comment("VERDICT #5: RETURN", late), comment("VERDICT #5: APPROVE", early, { authorName: "custom-reviewer" })], result(5, "approve"), { reviewerPattern: "^custom-reviewer$" });
});
test("repository filtering excludes other qualified repositories", () => {
  single([comment("VERDICT team/project#5: APPROVE"), comment("VERDICT other/project#5: RETURN", late)], result(5, "approve"), { repo: "team/project" });
});
test("map retains exact ids, date and head", () => {
  const c = comment("VERDICT #5: APPROVE head ABCDEF123456", late, { id: "comment-42", issueId: "issue-99" });
  single([c], result(5, "approve", late, { head: "abcdef123456", commentId: "comment-42", issueId: "issue-99" }));
});
test("repeated calls do not retain state or mutate input", () => {
  const input = [comment("VERDICT #5: APPROVE"), comment("VERDICT #6: RETURN", late)];
  const snapshot = structuredClone(input);
  const first = latestVerdicts(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(latestVerdicts([]), new Map());
  assert.deepEqual(latestVerdicts(input), first);
  assert.notStrictEqual(latestVerdicts(input), first);
  assert.deepEqual(input, snapshot);
});
