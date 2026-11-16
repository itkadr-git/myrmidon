import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { APPROVED_LABEL, decideApproveLabel, detectMigrationViolation, parseVerdictLines } from "./review-approve-label.mjs";

const head = "bd4b5f8924df56595fde8268885f8f912ff6b262";
const at = new Date("2026-10-08T07:00:00Z");
const verdict = { outcome: "approve", head, at };
const pr = { state: "open", merged: false, draft: false, headSha: head, labels: [], autoMerge: false, baseRef: "main", defaultBranch: "main" };
const base = { verdict, pr, headCommittedAt: null, ci: "success" };
const label = { action: "label", autoMerge: false, reason: "approved-head-green" };
const migrationPath = "packages/db/src/migrations/0433_existing.sql";
const violation = detectMigrationViolation([migrationPath], [migrationPath]);
const deadBase = { state: "closed", merged: true };

const cases = [
  ["no verdict before closed", { verdict: null, pr: { ...pr, state: "closed" } }, { action: "skip", reason: "no-verdict" }],
  ["refusal before draft", { verdict: { ...verdict, outcome: "refuse" }, pr: { ...pr, draft: true } }, { action: "skip", reason: "latest-verdict-refuse" }],
  ["head mismatch before failed CI", { pr: { ...pr, headSha: "f".repeat(40) }, ci: "failure" }, { action: "needs-rereview", reason: "head-moved-after-verdict" }],
  ["failed CI before migration violation", { ci: "failure", migrationViolation: violation }, { action: "skip", reason: "ci-failure" }],
  ["migration before stale base, armed and labeled", { migrationViolation: violation, baseBehind: true, pr: { ...pr, autoMerge: true, labels: [APPROVED_LABEL] } }, { action: "refuse", reason: "migration-overwrite", path: migrationPath, disableAutoMerge: true, removeLabel: true }],
  ["migration before stale base, not armed or labeled", { migrationViolation: violation, baseBehind: true }, { action: "refuse", reason: "migration-overwrite", path: migrationPath, disableAutoMerge: false, removeLabel: false }],
  ["stale base before dead stacked base", { baseBehind: true, basePr: deadBase, cannotRetarget: true, pr: { ...pr, baseRef: "feature/base", autoMerge: true } }, { action: "hold", disableAutoMerge: true, reason: "base-behind" }],
  ["stale base without armed merge", { baseBehind: true, basePr: deadBase, pr: { ...pr, baseRef: "feature/base" } }, { action: "hold", reason: "base-behind" }],
  ["dead base retarget", { basePr: deadBase, pr: { ...pr, baseRef: "feature/base", autoMerge: true } }, { action: "hold", reason: "base-retargeted-waiting-ci", retargetBase: "main", disableAutoMerge: true }],
  ["dead base cannot retarget", { basePr: deadBase, cannotRetarget: true, pr: { ...pr, baseRef: "feature/base", autoMerge: true, labels: [APPROVED_LABEL] } }, { action: "refuse", reason: "cannot-retarget-base-to-main", disableAutoMerge: true, removeLabel: true }],
  ["unpinned equal commit time", { verdict: { ...verdict, head: null }, headCommittedAt: at }, label],
  ["unpinned older commit", { verdict: { ...verdict, head: null }, headCommittedAt: new Date(at.getTime() - 1) }, label],
  ["unpinned newer commit", { verdict: { ...verdict, head: null }, headCommittedAt: new Date(at.getTime() + 1) }, { action: "needs-rereview", reason: "head-newer-than-verdict" }],
  ["unpinned missing commit time", { verdict: { ...verdict, head: null }, headCommittedAt: null }, { action: "needs-rereview", reason: "head-newer-than-verdict" }],
  ["release base ignores dead stacked PR", { basePr: deadBase, pr: { ...pr, baseRef: "rel/1.7" } }, label],
  ["custom default base ignores dead stacked PR", { basePr: deadBase, pr: { ...pr, baseRef: "trunk", defaultBranch: "trunk" } }, label],
  ["already labeled noop", { pr: { ...pr, labels: [APPROVED_LABEL] } }, { action: "noop", reason: "already-labeled" }],
  ["not-green main holds unlabeled auto merge", { mainGreen: false, mainCi: "in_progress", autoMerge: true }, { action: "label", autoMerge: false, reason: "approved-head-green", holdMerge: true }],
  ["not-green main holds labeled auto merge", { mainGreen: false, mainCi: "in_progress", autoMerge: true, pr: { ...pr, labels: [APPROVED_LABEL] } }, { action: "hold", reason: "main-not-green" }],
  ["red main disables armed labeled merge", { mainCi: "failure", autoMerge: true, pr: { ...pr, autoMerge: true, labels: [APPROVED_LABEL] } }, { action: "hold", disableAutoMerge: true, reason: "main-red" }],
  ["red main disables armed unlabeled merge", { mainCi: "failure", autoMerge: true, pr: { ...pr, autoMerge: true } }, { action: "label", autoMerge: false, reason: "approved-head-green", holdMerge: true, disableAutoMerge: true }],
];

for (const [name, overrides, expected] of cases) {
  test(name, () => assert.deepEqual(decideApproveLabel({ ...base, ...overrides }), expected));
}

for (const [name, pinned, actual] of [
  ["short uppercase verdict", head.slice(0, 12).toUpperCase(), head],
  ["full uppercase verdict", head.toUpperCase(), head],
  ["short lowercase verdict and uppercase head", head.slice(0, 12), head.toUpperCase()],
  ["full lowercase verdict and uppercase head", head, head.toUpperCase()],
]) {
  test(name, () => {
    const parsed = parseVerdictLines(`VERDICT #42: APPROVE head ${pinned}`)[0];
    assert.ok(parsed);
    assert.deepEqual(decideApproveLabel({ ...base, verdict: { ...parsed, at }, pr: { ...pr, headSha: actual } }), label);
  });
}

test("negative control detects an incorrect expected decision", () => {
  const directory = mkdtempSync(join(tmpdir(), "review-decision-negative-"));
  try {
    const source = readFileSync(new URL(import.meta.url), "utf8");
    const expected = '{ action: "skip", reason: "' + 'no-verdict" }';
    assert.equal(source.split(expected).length, 2);
    const altered = source.replace(expected, '{ action: "skip", reason: "pr-not-open" }')
      .replace('"./review-approve-label.mjs"', JSON.stringify(new URL("./review-approve-label.mjs", import.meta.url).href));
    const fixture = join(directory, "negative.test.mjs");
    writeFileSync(fixture, altered);
    // A nested test runner must not inherit the parent runner's recursion guard.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^no verdict before closed$", fixture], { encoding: "utf8", env });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /not ok 1 - no verdict before closed/);
    assert.match(result.stdout, /no-verdict/);
    assert.match(result.stdout, /pr-not-open/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
