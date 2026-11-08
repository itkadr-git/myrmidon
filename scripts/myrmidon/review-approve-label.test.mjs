import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  APPROVED_LABEL,
  boardVerdictSql,
  calculateBackoff,
  createFileStateStore,
  createGitHubPort,
  createMemoryStateStore,
  decideApproveLabel,
  detectMigrationViolation,
  latestVerdicts,
  main,
  parseVerdictLines,
  runOnce,
  selectCiResultConclusion,
} from "./review-approve-label.mjs";

const REPO = "owner/name";
const HEAD = "bd4b5f8924df56595fde8268885f8f912ff6b262";
const MAIN_HEAD = "1111222233334444555566667777888899990000";
const MAIN_MIGRATIONS = [
  "packages/db/src/migrations/0432_clean_raider.sql",
  "packages/db/src/migrations/0433_legacy_blocked_import.sql",
  "packages/db/src/migrations/meta/0432_snapshot.json",
  "packages/db/src/migrations/meta/0433_snapshot.json",
];
const comment = (body, at, authorName = "adm-dev-review", id = "c1") => ({ id, issueId: "i1", createdAt: at, authorName, body });

describe("parseVerdictLines", () => {
  it("reads the three verdict shapes the reviewers write", () => {
    assert.deepEqual(parseVerdictLines("VERDICT #484: APPROVE", REPO).map((m) => [m.prNumber, m.outcome, m.head]), [[484, "approve", null]]);
    const withHead = parseVerdictLines(`VERDICT: APPROVE - PR #895, head ${HEAD}`, REPO)[0];
    assert.equal(withHead.prNumber, 895);
    assert.equal(withHead.outcome, "approve");
    assert.equal(withHead.head, HEAD);
    const cyrillic = parseVerdictLines("ВЕРДИКТ РЕВЬЮЕРА (VERDICT-DBC4-2589fd2f9): APPROVED - PR #859, head 2589fd2f9d83", REPO)[0];
    assert.equal(cyrillic.outcome, "approve");
    assert.equal(cyrillic.head, "2589fd2f9d83");
  });
  it("reads a return as a refusal", () => {
    assert.equal(parseVerdictLines("NEW VERDICT #896: RETURN (8f1561e3f13b)", REPO)[0].outcome, "refuse");
    assert.equal(parseVerdictLines("VERDICT #882: DEFERRED", REPO)[0].outcome, "refuse");
  });
  it("never approves an unclear line", () => {
    assert.equal(parseVerdictLines("VERDICT #10: APPROVE but earlier RETURN", REPO)[0].outcome, "unclear");
    assert.deepEqual(parseVerdictLines("VERDICT #10, #11: APPROVE", REPO).map((m) => m.outcome), ["unclear", "unclear"]);
    assert.deepEqual(parseVerdictLines("I approve this idea, #10", REPO), []);
    assert.deepEqual(parseVerdictLines("VERDICT: APPROVE", REPO), []);
  });
  it("ignores another repository", () => {
    assert.deepEqual(parseVerdictLines("VERDICT other/repo#7: APPROVE", REPO), []);
    assert.equal(parseVerdictLines(`VERDICT ${REPO}#7: APPROVE`, REPO)[0].prNumber, 7);
  });
});

describe("latestVerdicts", () => {
  it("takes the newest verdict of the reviewer agents only", () => {
    const verdicts = latestVerdicts(
      [
        comment("VERDICT #5: APPROVE", "2026-10-08T06:00:00Z", "adm-dev-review", "a"),
        comment("VERDICT #5: RETURN", "2026-10-08T07:00:00Z", "adm-dev-review-4", "b"),
        comment("VERDICT #6: APPROVE", "2026-10-08T07:00:00Z", "adm-dev-eng-15", "c"),
        comment("VERDICT #7: RETURN\nVERDICT #7: APPROVE", "2026-10-08T07:00:00Z", "adm-dev-review", "d"),
      ],
      { repo: REPO },
    );
    assert.equal(verdicts.get(5).outcome, "refuse");
    assert.equal(verdicts.has(6), false);
    assert.equal(verdicts.get(7).outcome, "approve");
  });
});

describe("calculateBackoff", () => {
  it("returns 0 for 0 consecutive failures", () => {
    assert.equal(calculateBackoff({ consecutiveFailures: 0 }), 0);
    assert.equal(calculateBackoff({ consecutiveFailures: -1 }), 0);
  });
  it("scales exponentially with failures and caps at maxDelayMs", () => {
    assert.equal(calculateBackoff({ consecutiveFailures: 1, baseDelayMs: 30_000, factor: 2 }), 30_000);
    assert.equal(calculateBackoff({ consecutiveFailures: 2, baseDelayMs: 30_000, factor: 2 }), 60_000);
    assert.equal(calculateBackoff({ consecutiveFailures: 3, baseDelayMs: 30_000, factor: 2 }), 120_000);
    assert.equal(calculateBackoff({ consecutiveFailures: 10, baseDelayMs: 30_000, maxDelayMs: 300_000 }), 300_000);
  });
});

describe("decideApproveLabel", () => {
  const at = new Date("2026-10-08T07:00:00Z");
  const open = { state: "open", draft: false, merged: false, headSha: HEAD, labels: [] };
  const approve = { outcome: "approve", head: HEAD.slice(0, 12), at };

  it("labels an approved, unchanged, green head when main is green", () => {
    assert.equal(decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "success", mainCi: "success" }).action, "label");
  });

  it("labels approved PR but holds auto-merge when main CI is failure (red main)", () => {
    const decision = decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "success", mainCi: "failure", autoMerge: true });
    assert.equal(decision.action, "label");
    assert.equal(decision.autoMerge, false);
    assert.equal(decision.holdMerge, true);
  });

  // OPE-10520: main CI that has not completed green right now holds auto-merge,
  // even if the last completed run was green (incident #1923 merged into a main
  // whose fresh run was red). The label is still applied so CI keeps running.
  it("holds auto-merge when main CI is in_progress, even after green (OPE-10520)", () => {
    const decision = decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "success", mainCi: "in_progress", mainGreen: false, autoMerge: true });
    assert.equal(decision.action, "label");
    assert.equal(decision.autoMerge, false);
    assert.equal(decision.holdMerge, true);
  });

  it("refuses to merge a PR whose base is behind main (OPE-10520)", () => {
    const decision = decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "success", mainCi: "success", baseBehind: true, autoMerge: true });
    assert.equal(decision.action, "hold");
    assert.equal(decision.reason, "base-behind");
    assert.notEqual(decision.autoMerge, true);
  });

  it("disables an armed auto-merge when the PR base falls behind main (OPE-10520)", () => {
    const decision = decideApproveLabel({
      verdict: approve,
      pr: { ...open, labels: [APPROVED_LABEL], autoMerge: true },
      headCommittedAt: null,
      ci: "success",
      mainCi: "success",
      baseBehind: true,
      autoMerge: true,
    });
    assert.equal(decision.action, "hold");
    assert.equal(decision.reason, "base-behind");
    assert.equal(decision.disableAutoMerge, true);
  });

  it("refuses PRs that rewrite an existing migration or add a stale snapshot number (OPE-10520)", () => {
    const overwrite = decideApproveLabel({
      verdict: approve,
      pr: { ...open, labels: [APPROVED_LABEL], autoMerge: true },
      headCommittedAt: null,
      ci: "success",
      mainCi: "success",
      migrationViolation: { reason: "migration-overwrite", path: "packages/db/src/migrations/0433_legacy_blocked_import.sql" },
      autoMerge: true,
    });
    assert.equal(overwrite.action, "refuse");
    assert.equal(overwrite.reason, "migration-overwrite");
    assert.equal(overwrite.disableAutoMerge, true);
    assert.equal(overwrite.removeLabel, true);

    const stale = decideApproveLabel({
      verdict: approve,
      pr: open,
      headCommittedAt: null,
      ci: "success",
      mainCi: "success",
      migrationViolation: { reason: "migration-stale-number", path: "packages/db/src/migrations/meta/0430_snapshot.json" },
      autoMerge: true,
    });
    assert.equal(stale.action, "refuse");
    assert.equal(stale.reason, "migration-stale-number");
  });

  // OPE-10815: stacked PR base check
  it("holds auto-merge and retargets base when stacked PR base is merged (OPE-10815)", () => {
    const decision = decideApproveLabel({
      verdict: approve,
      pr: { ...open, baseRef: "bot/OPE-9262", defaultBranch: "main", autoMerge: true },
      headCommittedAt: null,
      ci: "success",
      mainCi: "success",
      basePr: { number: 1959, state: "closed", merged: true },
      autoMerge: true,
    });
    assert.equal(decision.action, "hold");
    assert.equal(decision.reason, "base-retargeted-waiting-ci");
    assert.equal(decision.retargetBase, "main");
    assert.equal(decision.disableAutoMerge, true);
  });

  it("refuses stacked PR when retargeting to main fails (OPE-10815)", () => {
    const decision = decideApproveLabel({
      verdict: approve,
      pr: { ...open, labels: [APPROVED_LABEL], baseRef: "bot/OPE-9262", defaultBranch: "main", autoMerge: true },
      headCommittedAt: null,
      ci: "success",
      mainCi: "success",
      basePr: { number: 1959, state: "closed", merged: true },
      cannotRetarget: true,
      autoMerge: true,
    });
    assert.equal(decision.action, "refuse");
    assert.equal(decision.reason, "cannot-retarget-base-to-main");
    assert.equal(decision.disableAutoMerge, true);
    assert.equal(decision.removeLabel, true);
  });

  it("allows normal labeling when base is rel/* branch (OPE-10815)", () => {
    const decision = decideApproveLabel({
      verdict: approve,
      pr: { ...open, baseRef: "rel/1.6.6", defaultBranch: "main" },
      headCommittedAt: null,
      ci: "success",
      mainCi: "success",
      mainGreen: true,
      autoMerge: true,
    });
    assert.equal(decision.action, "label");
    assert.equal(decision.autoMerge, true);
  });

  it("holds auto-merge for an already labeled PR when main CI is failure", () => {
    const decision = decideApproveLabel({
      verdict: approve,
      pr: { ...open, labels: [APPROVED_LABEL] },
      headCommittedAt: null,
      ci: "success",
      mainCi: "failure",
      autoMerge: true,
    });
    assert.equal(decision.action, "hold");
    assert.equal(decision.reason, "main-red");
  });

  it("is a no-op when the label is already there and autoMerge is inactive", () => {
    assert.equal(decideApproveLabel({ verdict: approve, pr: { ...open, labels: [APPROVED_LABEL] }, headCommittedAt: null, ci: "success" }).action, "noop");
  });

  it("enables autoMerge when requested and not yet active on the PR", () => {
    const decision = decideApproveLabel({
      verdict: approve,
      pr: { ...open, labels: [APPROVED_LABEL], autoMerge: false },
      headCommittedAt: null,
      ci: "success",
      mainCi: "success",
      autoMerge: true,
    });
    assert.equal(decision.action, "label");
    assert.equal(decision.autoMerge, true);
  });

  it("is a no-op when already labeled and autoMerge is already enabled", () => {
    const decision = decideApproveLabel({
      verdict: approve,
      pr: { ...open, labels: [APPROVED_LABEL], autoMerge: true },
      headCommittedAt: null,
      ci: "success",
      mainCi: "success",
      autoMerge: true,
    });
    assert.equal(decision.action, "noop");
    assert.equal(decision.reason, "already-labeled");
  });

  it("does not label when the head moved after the verdict", () => {
    const decision = decideApproveLabel({ verdict: approve, pr: { ...open, headSha: "f".repeat(40) }, headCommittedAt: null, ci: "success" });
    assert.equal(decision.action, "needs-rereview");
  });

  it("without a pinned head, the head commit must be older than the verdict", () => {
    const unpinned = { outcome: "approve", head: null, at };
    assert.equal(decideApproveLabel({ verdict: unpinned, pr: open, headCommittedAt: new Date("2026-10-08T06:00:00Z"), ci: "success" }).action, "label");
    assert.equal(decideApproveLabel({ verdict: unpinned, pr: open, headCommittedAt: new Date("2026-10-08T08:00:00Z"), ci: "success" }).action, "needs-rereview");
    assert.equal(decideApproveLabel({ verdict: unpinned, pr: open, headCommittedAt: null, ci: "success" }).action, "needs-rereview");
  });

  it("waits for a green CI result and skips closed, merged and draft PRs", () => {
    assert.deepEqual(decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "failure" }), { action: "skip", reason: "ci-failure" });
    assert.equal(decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "in_progress" }).action, "skip");
    assert.equal(decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "queued" }).action, "skip");
    assert.equal(decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "missing" }).action, "skip");
    assert.equal(decideApproveLabel({ verdict: approve, pr: { ...open, state: "closed" }, headCommittedAt: null, ci: "success" }).reason, "pr-not-open");
    assert.equal(decideApproveLabel({ verdict: approve, pr: { ...open, merged: true }, headCommittedAt: null, ci: "success" }).reason, "pr-not-open");
    assert.equal(decideApproveLabel({ verdict: approve, pr: { ...open, draft: true }, headCommittedAt: null, ci: "success" }).reason, "pr-draft");
  });

  it("queued/in_progress/missing CI on the PR does not permit auto-merge or labeling", () => {
    for (const nonGreenCi of ["queued", "in_progress", "missing"]) {
      const decision = decideApproveLabel({
        verdict: approve,
        pr: open,
        headCommittedAt: null,
        ci: nonGreenCi,
        mainCi: "success",
        autoMerge: true,
      });
      assert.equal(decision.action, "skip");
      assert.equal(decision.reason, `ci-${nonGreenCi}`);
      assert.notEqual(decision.autoMerge, true);
    }
  });

  it("already-labeled PR with queued/in_progress/missing CI does not permit auto-merge", () => {
    for (const nonGreenCi of ["queued", "in_progress", "missing"]) {
      const decision = decideApproveLabel({
        verdict: approve,
        pr: { ...open, labels: [APPROVED_LABEL] },
        headCommittedAt: null,
        ci: nonGreenCi,
        mainCi: "success",
        autoMerge: true,
      });
      assert.equal(decision.action, "skip");
      assert.equal(decision.reason, `ci-${nonGreenCi}`);
      assert.notEqual(decision.autoMerge, true);
    }
  });
});

describe("detectMigrationViolation", () => {
  it("flags a PR that rewrites an existing migration .sql on main", () => {
    const v = detectMigrationViolation(
      ["server/src/x.ts", "packages/db/src/migrations/0433_legacy_blocked_import.sql"],
      MAIN_MIGRATIONS,
    );
    assert.deepEqual(v, { reason: "migration-overwrite", path: "packages/db/src/migrations/0433_legacy_blocked_import.sql" });
  });

  it("flags a PR that rewrites an existing snapshot on main", () => {
    const v = detectMigrationViolation(["packages/db/src/migrations/meta/0433_snapshot.json"], MAIN_MIGRATIONS);
    assert.equal(v.reason, "migration-overwrite");
  });

  it("flags a new snapshot numbered below the newest on main (chain break)", () => {
    const v = detectMigrationViolation(["packages/db/src/migrations/meta/0430_snapshot.json"], MAIN_MIGRATIONS);
    assert.deepEqual(v, { reason: "migration-stale-number", path: "packages/db/src/migrations/meta/0430_snapshot.json" });
  });

  it("allows new migrations above the newest on main and unrelated files", () => {
    assert.equal(
      detectMigrationViolation(
        ["packages/db/src/migrations/0434_new_one.sql", "packages/db/src/migrations/meta/0434_snapshot.json", "server/src/x.ts"],
        MAIN_MIGRATIONS,
      ),
      null,
    );
  });

  it("ignores files outside the migrations tree even with 4-digit prefixes", () => {
    assert.equal(detectMigrationViolation(["packages/db/src/migrations/README.md", "doc/0433_notes.md"], MAIN_MIGRATIONS), null);
  });
});

function fakeGitHub(prs, { mainCi = 'success', mainHeadSha = MAIN_HEAD, lastCompletedMain = null, basePrs = {} } = {}) {
  const labeled = [];
  const autoMerged = [];
  const autoMergeCalls = [];
  const autoDisabled = [];
  const removedLabels = [];
  const updatedBranches = [];
  const retargetedBases = [];
  return {
    labeled,
    autoMerged,
    autoMergeCalls,
    autoDisabled,
    removedLabels,
    updatedBranches,
    retargetedBases,
    async pullRequest(n) {
      if (!prs[n]) throw new Error('404');
      return prs[n].pr;
    },
    async pullRequestFiles(n) {
      return prs[n]?.files ?? [];
    },
    async mainMigrationFiles() {
      return MAIN_MIGRATIONS;
    },
    async updatePullRequestBase(n, base) {
      retargetedBases.push({ prNumber: n, base });
    },
    async findPullRequestByHead(head) {
      return basePrs[head] ?? null;
    },
    async updateBranch(n) {
      updatedBranches.push(n);
    },
    async removeLabel(n) {
      removedLabels.push(n);
    },
    async headCommittedAt() {
      return new Date("2026-10-08T05:00:00Z");
    },
    async ciConclusion(sha) {
      if (sha === mainHeadSha) return mainCi;
      const matchKey = Object.keys(prs).find((k) => prs[k].pr.headSha === sha);
      return matchKey ? prs[matchKey].ci : "missing";
    },
    async mainHeadSha() {
      return mainHeadSha;
    },
    async mainCiConclusion() {
      return mainCi;
    },
    async mainCiDetails() {
      return {
        status: mainCi,
        conclusion: mainCi,
        lastCompleted: lastCompletedMain,
      };
    },
    async addLabel(n) {
      labeled.push(n);
    },
    async enableAutoMerge(n, headSha) {
      autoMerged.push(n);
      autoMergeCalls.push({ number: n, headSha: headSha ?? null });
    },
    async disableAutoMerge(n) {
      autoDisabled.push(n);
    },
  };
}

describe("runOnce with green main protection and auto-merge", () => {
  const open = (headSha, labels = [], autoMerge = false, baseSha = MAIN_HEAD) => ({ state: "open", draft: false, merged: false, headSha, baseSha, labels, autoMerge });
  const comments = [
    comment(`VERDICT #1: APPROVE (head ${HEAD})`, "2026-10-08T07:00:00Z", "adm-dev-review", "a"),
    comment("VERDICT #2: APPROVE", "2026-10-08T07:00:00Z", "adm-dev-review", "b"),
    comment("VERDICT #3: RETURN", "2026-10-08T07:00:00Z", "adm-dev-review", "c"),
    comment("VERDICT #4: APPROVE", "2026-10-08T07:00:00Z", "adm-dev-review", "d"),
  ];

  it("labels only what is approved, current and green when main is green", async () => {
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
      2: { pr: open("a".repeat(40)), ci: "failure" },
      4: { pr: open("b".repeat(40), [APPROVED_LABEL]), ci: "success" },
    }, { mainCi: "success" });
    const lines = [];
    const { results, failed } = await runOnce({ comments, repo: REPO, github, log: (l) => lines.push(l) });
    assert.deepEqual(github.labeled, [1]);
    assert.equal(failed, 0);
    assert.deepEqual(results.map((r) => [r.prNumber, r.action]), [[1, "label"], [2, "skip"], [3, "skip"], [4, "noop"]]);
  });

  // Acceptance Criterion 1: test main failure -> labels PR, does not enable auto-merge, increments pause/backoff
  it("acceptance: main failure -> labels PR, does not enable auto-merge, increments pause/backoff", async () => {
    const store = createMemoryStateStore();
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
      2: { pr: open("a".repeat(40)), ci: "success" },
    }, { mainCi: "failure" });

    const now = new Date("2026-10-30T10:00:00Z");
    const { results, paused, consecutiveFailures, backoffUntil } = await runOnce({
      comments,
      repo: REPO,
      github,
      stateStore: store,
      now,
      baseDelayMs: 30_000,
      autoMerge: true,
    });

    assert.equal(paused, true);
    assert.equal(consecutiveFailures, 1, "consecutiveFailures should increment on failure");
    assert.equal(backoffUntil, "2026-10-30T10:00:30.000Z");
    assert.deepEqual(github.labeled, [1, 2], "PRs should still be labeled so CI can run");
    assert.deepEqual(github.autoMerged, [], "No auto-merge should be enabled when main is red");

    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "label");
    assert.equal(r1.autoMerge, false);

    const saved = await store.load();
    assert.equal(saved.consecutiveFailures, 1);
    assert.equal(saved.mainStatus, "failure");
  });

  // OPE-10520: main CI that has not completed green right now holds auto-merge —
  // even if the last completed run was green (incident #1923). The label is
  // still applied so CI pipelines keep running; the pause counter does not grow.
  it("acceptance: main in_progress after green -> labels PR, holds auto-merge, pause does not grow", async () => {
    const store = createMemoryStateStore({
      consecutiveFailures: 0,
      backoffUntil: null,
      mainStatus: "success",
      lastCompletedStatus: "success",
    });
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
    }, { mainCi: "in_progress", lastCompletedMain: "success" });

    const { results, paused, consecutiveFailures, backoffUntil } = await runOnce({
      comments,
      repo: REPO,
      github,
      stateStore: store,
      autoMerge: true,
    });

    assert.equal(paused, true);
    assert.equal(consecutiveFailures, 0);
    assert.equal(backoffUntil, null);
    assert.deepEqual(github.labeled, [1], "PR should be labeled");
    assert.deepEqual(github.autoMerged, [], "Auto-merge must be held while the newest main CI run is not completed success");
    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "label");
    assert.equal(r1.autoMerge, false);
    assert.equal(r1.holdMerge, true);
  });

  // Acceptance Case: main in_progress после красного → автовливание стоит (метка ставится, пауза не растёт)
  it("acceptance: main in_progress after red -> labels PR, holds auto-merge, pause does not grow", async () => {
    const store = createMemoryStateStore({
      consecutiveFailures: 1,
      backoffUntil: null,
      mainStatus: "failure",
      lastCompletedStatus: "failure",
    });
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
    }, { mainCi: "in_progress", lastCompletedMain: "failure" });

    const { results, paused, consecutiveFailures } = await runOnce({
      comments,
      repo: REPO,
      github,
      stateStore: store,
      autoMerge: true,
    });

    assert.equal(paused, true);
    assert.equal(consecutiveFailures, 1, "consecutiveFailures should not grow during in_progress");
    assert.deepEqual(github.labeled, [1], "PR should still be labeled so CI can run");
    assert.deepEqual(github.autoMerged, [], "Auto-merge should be held");
    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "label");
    assert.equal(r1.autoMerge, false);
  });

  // Acceptance Case: disables auto-merge on an already auto-merged PR when main is red
  it("acceptance: disables auto-merge on an already auto-merged PR when main is red", async () => {
    const github = fakeGitHub({
      1: { pr: open(HEAD, [APPROVED_LABEL], true), ci: "success" },
    }, { mainCi: "failure" });

    const { results } = await runOnce({
      comments,
      repo: REPO,
      github,
      autoMerge: true,
    });

    assert.deepEqual(github.autoDisabled, [1]);
    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "hold");
    assert.equal(r1.disableAutoMerge, true);
  });

  // Acceptance Criterion 2: test зелёный -> возобновление
  it("acceptance: resumes merge when main CI becomes green and resets backoff", async () => {
    const store = createMemoryStateStore({
      consecutiveFailures: 3,
      backoffUntil: null,
      mainStatus: "failure",
    });
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
      2: { pr: open("a".repeat(40)), ci: "failure" },
      4: { pr: open("b".repeat(40), [APPROVED_LABEL], true), ci: "success" },
    }, { mainCi: "success" });

    const { results, consecutiveFailures, failed } = await runOnce({
      comments,
      repo: REPO,
      github,
      stateStore: store,
      autoMerge: true,
    });

    assert.equal(failed, 0);
    assert.deepEqual(github.labeled, [1]);
    assert.deepEqual(github.autoMerged, [1]);
    assert.equal(consecutiveFailures, 0);

    const saved = await store.load();
    assert.equal(saved.consecutiveFailures, 0);
    assert.equal(saved.backoffUntil, null);
    assert.equal(saved.mainStatus, "success");

    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "label");
    assert.equal(r1.autoMerge, true);
  });

  // Acceptance Criterion 3: test повторная обработка безопасна (idempotent)
  it("acceptance: repeated processing is safe and idempotent with no duplicate actions", async () => {
    const store = createMemoryStateStore();
    // PR 1 and PR 4 are already labeled and have autoMerge active; PR 2 is failing CI
    const github = fakeGitHub({
      1: { pr: open(HEAD, [APPROVED_LABEL], true), ci: "success" },
      2: { pr: open("a".repeat(40), [], false), ci: "failure" },
      4: { pr: open("b".repeat(40), [APPROVED_LABEL], true), ci: "success" },
    }, { mainCi: "success" });

    const { results, failed } = await runOnce({
      comments,
      repo: REPO,
      github,
      stateStore: store,
      autoMerge: true,
    });

    assert.equal(failed, 0);
    assert.deepEqual(github.labeled, [], "Repeated run should not call addLabel");
    assert.deepEqual(github.autoMerged, [], "Repeated run should not call enableAutoMerge");

    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "noop");
    assert.equal(r1.reason, "already-labeled");
  });

  // OPE-12186: the arm command must be pinned to the approved head. (а) A verdict
  // naming head A while the PR head is already B is the existing п.4 gate — no
  // label, no auto-merge. (б) When the verdict head and the PR head are both A,
  // the arm call carries that head so GitHub can only merge exactly it.
  it("does not label or arm auto-merge when the head moved after the verdict (race)", async () => {
    const moved = "c".repeat(40);
    const github = fakeGitHub({
      1: { pr: open(moved), ci: "success" },
    }, { mainCi: "success" });
    const { results, failed } = await runOnce({
      comments: [comment(`VERDICT #1: APPROVE (head ${HEAD})`, "2026-10-08T07:00:00Z", "adm-dev-review", "r1")],
      repo: REPO,
      github,
      autoMerge: true,
    });
    assert.equal(failed, 0);
    assert.equal(results[0].action, "needs-rereview");
    assert.deepEqual(github.labeled, [], "a moved head must not be labeled");
    assert.deepEqual(github.autoMerged, [], "a moved head must not arm auto-merge");
    assert.deepEqual(github.autoMergeCalls, []);
  });

  it("arms auto-merge pinned to the approved head (--match-head-commit <head>)", async () => {
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
    }, { mainCi: "success" });
    const { results, failed } = await runOnce({
      comments: [comment(`VERDICT #1: APPROVE (head ${HEAD})`, "2026-10-08T07:00:00Z", "adm-dev-review", "r2")],
      repo: REPO,
      github,
      autoMerge: true,
    });
    assert.equal(failed, 0);
    assert.equal(results[0].action, "label");
    assert.equal(results[0].autoMerge, true);
    assert.deepEqual(github.autoMerged, [1]);
    assert.deepEqual(github.autoMergeCalls, [{ number: 1, headSha: HEAD }], "the arm call must carry the approved head sha");
  });

  it("skips auto-merge during active backoff window while still labeling PRs", async () => {
    const future = new Date("2026-10-30T10:05:00Z").toISOString();
    const store = createMemoryStateStore({
      consecutiveFailures: 2,
      backoffUntil: future,
      mainStatus: "failure",
      lastCompletedStatus: "failure",
    });
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
    }, { mainCi: "failure" });

    const now = new Date("2026-10-30T10:01:00Z");
    const { paused, backoffUntil, consecutiveFailures } = await runOnce({
      comments,
      repo: REPO,
      github,
      stateStore: store,
      now,
      autoMerge: true,
    });

    assert.equal(paused, true);
    assert.equal(backoffUntil, future);
    assert.equal(consecutiveFailures, 2, "consecutiveFailures should not increment while in backoff");
    assert.deepEqual(github.labeled, [1], "PR should still be labeled during backoff");
    assert.deepEqual(github.autoMerged, [], "Auto-merge should not be enabled during backoff");
  });

  it("does not write in a dry run, and counts a failed GitHub call", async () => {
    const github = fakeGitHub({ 1: { pr: open(HEAD), ci: "success" } }, { mainCi: "success" });
    const dry = await runOnce({ comments, repo: REPO, github, dryRun: true });
    assert.deepEqual(github.labeled, []);
    assert.equal(dry.results.find((r) => r.prNumber === 1).dryRun, true);
    assert.equal(dry.failed, 2);
  });

  // Acceptance Case: queued/in_progress/missing CI у самого PR не разрешает включение auto-merge
  it("acceptance: queued/in_progress/missing CI on the PR does not permit auto-merge", async () => {
    for (const nonGreenCi of ["queued", "in_progress", "missing"]) {
      const github = fakeGitHub({
        1: { pr: open(HEAD, [], false), ci: nonGreenCi },
        2: { pr: open("a".repeat(40), [APPROVED_LABEL], false), ci: nonGreenCi },
      }, { mainCi: "success" });

      const { results } = await runOnce({
        comments,
        repo: REPO,
        github,
        autoMerge: true,
      });

      assert.deepEqual(github.autoMerged, [], `auto-merge must not be enabled when PR CI is ${nonGreenCi}`);
      const r1 = results.find((r) => r.prNumber === 1);
      assert.equal(r1.action, "skip");
      assert.equal(r1.reason, `ci-${nonGreenCi}`);
      const r2 = results.find((r) => r.prNumber === 2);
      assert.equal(r2.action, "skip");
      assert.equal(r2.reason, `ci-${nonGreenCi}`);
    }
  });

  // Acceptance Case: main CI missing falls back to last completed CI status and holds auto-merge when red
  it("acceptance: main CI missing falls back to last completed CI status and holds auto-merge when red", async () => {
    const store = createMemoryStateStore({
      consecutiveFailures: 1,
      backoffUntil: null,
      mainStatus: "failure",
      lastCompletedStatus: "failure",
    });
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
    }, { mainCi: "missing", lastCompletedMain: "failure" });

    const { paused } = await runOnce({
      comments,
      repo: REPO,
      github,
      stateStore: store,
      autoMerge: true,
    });

    assert.equal(paused, true, "auto-merge should be paused when main CI is missing and last completed was failure");
    assert.deepEqual(github.autoMerged, []);
  });

  // OPE-10520 acceptance: PR whose base lags main never merges; update-branch is requested instead.
  const singleApproveComments = [comment(`VERDICT #1: APPROVE (head ${HEAD})`, "2026-10-08T07:00:00Z", "adm-dev-review", "a")];
  it("acceptance: stale base -> holds auto-merge and asks GitHub to update-branch", async () => {
    const github = fakeGitHub({
      1: { pr: open(HEAD, [], false, "9999888877776666555544443333222211110000"), ci: "success" },
    }, { mainCi: "success" });

    const { results, failed } = await runOnce({
      comments: singleApproveComments,
      repo: REPO,
      github,
      autoMerge: true,
    });

    assert.equal(failed, 0);
    assert.deepEqual(github.autoMerged, [], "stale-base PR must never auto-merge");
    assert.deepEqual(github.updatedBranches, [1], "update-branch should be requested");
    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "hold");
    assert.equal(r1.reason, "base-behind");
  });

  // OPE-10520 acceptance: armed auto-merge is disarmed when the base falls behind.
  it("acceptance: armed auto-merge is disabled when the base falls behind main", async () => {
    const github = fakeGitHub({
      1: { pr: open(HEAD, [APPROVED_LABEL], true, "9999888877776666555544443333222211110000"), ci: "success" },
    }, { mainCi: "success" });

    const { results } = await runOnce({
      comments: singleApproveComments,
      repo: REPO,
      github,
      autoMerge: true,
    });

    assert.deepEqual(github.autoDisabled, [1]);
    assert.deepEqual(github.autoMerged, []);
    assert.deepEqual(github.updatedBranches, [1]);
    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "hold");
    assert.equal(r1.reason, "base-behind");
    assert.equal(r1.disableAutoMerge, true);
  });

  // OPE-10520 acceptance: PR rewriting an already-applied migration is refused.
  it("acceptance: PR that rewrites an existing migration is refused and disarmed", async () => {
    const github = fakeGitHub({
      1: {
        pr: open(HEAD, [APPROVED_LABEL], true),
        ci: "success",
        files: ["server/src/x.ts", "packages/db/src/migrations/0433_legacy_blocked_import.sql"],
      },
    }, { mainCi: "success" });

    const { results, failed } = await runOnce({
      comments: singleApproveComments,
      repo: REPO,
      github,
      autoMerge: true,
    });

    assert.equal(failed, 0);
    assert.deepEqual(github.autoMerged, []);
    assert.deepEqual(github.autoDisabled, [1]);
    assert.deepEqual(github.removedLabels, [1], "the review-approved label must be stripped on refusal");
    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "refuse");
    assert.equal(r1.reason, "migration-overwrite");
  });

  // OPE-10520 acceptance: PR adding a snapshot below the newest on main is refused.
  it("acceptance: PR adding a snapshot numbered below the newest on main is refused", async () => {
    const github = fakeGitHub({
      1: {
        pr: open(HEAD),
        ci: "success",
        files: ["packages/db/src/migrations/meta/0430_snapshot.json"],
      },
    }, { mainCi: "success" });

    const { results, failed } = await runOnce({
      comments: singleApproveComments,
      repo: REPO,
      github,
      autoMerge: true,
    });

    assert.equal(failed, 0);
    assert.deepEqual(github.autoMerged, []);
    assert.deepEqual(github.labeled, [], "a violating PR must not be labeled");
    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "refuse");
    assert.equal(r1.reason, "migration-stale-number");
  });

  // OPE-10520 acceptance: migration guard listing failure holds auto-merge (fail closed).
  it("acceptance: migration guard listing failure holds auto-merge", async () => {
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
    }, { mainCi: "success" });
    github.mainMigrationFiles = async () => [];

    const { results } = await runOnce({
      comments: singleApproveComments,
      repo: REPO,
      github,
      autoMerge: true,
    });

    assert.deepEqual(github.autoMerged, [], "merge must be held when the migration listing is unavailable");
    assert.deepEqual(github.labeled, [1], "labeling still works so CI keeps running");
    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "label");
    assert.equal(r1.autoMerge, false);
  });

  // OPE-10815 acceptance: stacked PR with merged base PR is retargeted to main and auto-merge is held
  it("acceptance: stacked PR with merged base PR is retargeted to main and holds auto-merge", async () => {
    const github = fakeGitHub({
      1: {
        pr: { ...open(HEAD), baseRef: "bot/OPE-9262", defaultBranch: "main" },
        ci: "success",
      },
    }, {
      mainCi: "success",
      basePrs: {
        "bot/OPE-9262": { number: 1959, state: "closed", merged: true },
      },
    });

    const { results } = await runOnce({
      comments: singleApproveComments,
      repo: REPO,
      github,
      autoMerge: true,
    });

    assert.deepEqual(github.retargetedBases, [{ prNumber: 1, base: "main" }]);
    assert.deepEqual(github.autoMerged, []);
    assert.deepEqual(github.labeled, []);
    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "hold");
    assert.equal(r1.reason, "base-retargeted-waiting-ci");
  });
});

describe("createFileStateStore", () => {
  it("persists and reads back state across runs", async () => {
    const tmpFile = path.join(os.tmpdir(), `automerge-state-test-${Date.now()}.json`);
    try {
      const store = createFileStateStore(tmpFile);
      assert.equal(await store.load(), null);
      await store.save({ consecutiveFailures: 2, mainStatus: "failure" });
      const loaded = await store.load();
      assert.deepEqual(loaded, { consecutiveFailures: 2, mainStatus: "failure" });
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });
});

describe("createGitHubPort", () => {
  it("reads the CI result check run of the head and adds the label with a labels array", async () => {
    const calls = [];
    const port = createGitHubPort(REPO, async (args) => {
      calls.push(args);
      if (args[0].includes("check-runs")) {
        return { check_runs: [{ name: "build", status: "completed", conclusion: "failure" }, { name: "CI result", status: "completed", conclusion: "success", started_at: "2026-10-08T07:00:00Z" }] };
      }
      return {};
    });
    assert.equal(await port.ciConclusion(HEAD), "success");
    await port.addLabel(12);
    assert.deepEqual(calls.at(-1), ["-X", "POST", `repos/${REPO}/issues/12/labels`, "-f", `labels[]=${APPROVED_LABEL}`]);
  });

  it("inspects main head commit and queries CI conclusion", async () => {
    const calls = [];
    const port = createGitHubPort(REPO, {
      run: async (args) => {
        calls.push(args);
        if (args[0].includes("commits/main")) return { sha: MAIN_HEAD };
        if (args[0].includes("check-runs")) {
          return { check_runs: [{ name: "CI result", status: "completed", conclusion: "success" }] };
        }
        return {};
      },
    });
    const mainSha = await port.mainHeadSha("main");
    assert.equal(mainSha, MAIN_HEAD);
    const conclusion = await port.mainCiConclusion("main");
    assert.equal(conclusion, "success");
  });

  it("invokes gh pr merge for auto-merge enable and disable", async () => {
    const prCalls = [];
    const port = createGitHubPort(REPO, {
      runPr: async (args) => {
        prCalls.push(args);
        return "";
      },
    });
    await port.enableAutoMerge(42, HEAD);
    assert.deepEqual(prCalls[0], ["merge", "42", "-R", REPO, "--auto", "--squash", "--match-head-commit", HEAD]);
    await port.disableAutoMerge(42);
    assert.deepEqual(prCalls[1], ["merge", "42", "-R", REPO, "--disable-auto"]);
  });

  it("refuses to arm auto-merge without a head sha (fail closed, OPE-12186)", async () => {
    const prCalls = [];
    const port = createGitHubPort(REPO, {
      runPr: async (args) => {
        prCalls.push(args);
        return "";
      },
    });
    await assert.rejects(port.enableAutoMerge(42), /head sha is required/);
    assert.deepEqual(prCalls, [], "no gh pr merge command may run without --match-head-commit");
  });
});

// OPE-10461: the workflow skips `CI result` on label events, so after the
// `review-approved` label (or any other) the newest `CI result` run of a head is a
// `skipped` one. It is not a verdict; the real result of the head is the run before.
describe("selectCiResultConclusion", () => {
  const ci = (id, startedAt, status, conclusion = null, name = "CI result") => ({
    id,
    name,
    status,
    conclusion,
    started_at: startedAt,
  });
  const T1 = "2026-11-06T10:00:00Z";
  const T2 = "2026-11-06T10:30:00Z";
  const T3 = "2026-11-06T11:00:00Z";

  it("a skipped run newer than a success gives success", () => {
    assert.equal(selectCiResultConclusion([ci(1, T1, "completed", "success"), ci(2, T2, "completed", "skipped")]), "success");
    // whatever order GitHub lists them in
    assert.equal(selectCiResultConclusion([ci(2, T2, "completed", "skipped"), ci(1, T1, "completed", "success")]), "success");
  });

  it("a skipped run newer than a failure gives failure", () => {
    assert.equal(selectCiResultConclusion([ci(1, T1, "completed", "failure"), ci(2, T2, "completed", "skipped")]), "failure");
    assert.equal(selectCiResultConclusion([ci(2, T2, "completed", "skipped"), ci(1, T1, "completed", "failure")]), "failure");
  });

  it("several skipped runs on top of the real one are all passed over", () => {
    const runs = [ci(1, T1, "completed", "success"), ci(2, T2, "completed", "skipped"), ci(3, T3, "completed", "skipped")];
    assert.equal(selectCiResultConclusion(runs), "success");
  });

  it("a head with only skipped runs has no verdict yet: pending, never success", () => {
    assert.equal(selectCiResultConclusion([ci(2, T2, "completed", "skipped")]), "pending");
    assert.equal(selectCiResultConclusion([ci(2, T2, "completed", "skipped"), ci(3, T3, "completed", "skipped")]), "pending");
  });

  it("no CI result run at all stays missing, other checks are not a CI result", () => {
    assert.equal(selectCiResultConclusion([]), "missing");
    assert.equal(selectCiResultConclusion(undefined), "missing");
    assert.equal(selectCiResultConclusion([ci(1, T1, "completed", "success", "tests")]), "missing");
  });

  it("the newest real run decides: a later failure beats an earlier success and the other way round", () => {
    assert.equal(selectCiResultConclusion([ci(1, T1, "completed", "success"), ci(2, T2, "completed", "failure")]), "failure");
    assert.equal(selectCiResultConclusion([ci(1, T1, "completed", "failure"), ci(2, T2, "completed", "success")]), "success");
    assert.equal(
      selectCiResultConclusion([ci(1, T1, "completed", "success"), ci(2, T2, "completed", "failure"), ci(3, T3, "completed", "skipped")]),
      "failure",
    );
  });

  it("cancelled, timed_out, neutral, action_required are never success", () => {
    for (const conclusion of ["cancelled", "timed_out", "neutral", "action_required", "stale", "startup_failure"]) {
      const alone = selectCiResultConclusion([ci(2, T2, "completed", conclusion)]);
      assert.equal(alone, conclusion);
      assert.notEqual(alone, "success");
      // an older success does not rescue a newer real outcome; a skipped run on top changes nothing
      const withOlderSuccess = selectCiResultConclusion([ci(1, T1, "completed", "success"), ci(2, T2, "completed", conclusion), ci(3, T3, "completed", "skipped")]);
      assert.equal(withOlderSuccess, conclusion);
    }
    // a completed run without any conclusion is not success either
    assert.equal(selectCiResultConclusion([ci(2, T2, "completed", null)]), "unknown");
  });

  it("a run still going on top is pending, also behind a skipped one; an older running run does not block a newer verdict", () => {
    assert.equal(selectCiResultConclusion([ci(1, T1, "completed", "success"), ci(2, T2, "in_progress")]), "in_progress");
    assert.equal(selectCiResultConclusion([ci(1, T1, "completed", "success"), ci(2, T2, "queued")]), "queued");
    assert.equal(
      selectCiResultConclusion([ci(1, T1, "completed", "success"), ci(2, T2, "in_progress"), ci(3, T3, "completed", "skipped")]),
      "in_progress",
    );
    assert.equal(selectCiResultConclusion([ci(1, T1, "in_progress"), ci(2, T2, "completed", "success")]), "success");
  });

  it("falls back to the run id when two runs start in the same second", () => {
    const runs = [ci(7, T1, "completed", "success"), ci(9, T1, "completed", "failure")];
    assert.equal(selectCiResultConclusion(runs), "failure");
  });
});

describe("createGitHubPort CI result with skipped label-event runs", () => {
  /**
   * A GitHub that behaves like the real check-runs endpoint: the default
   * `filter=latest` returns the newest run of every check name within a check
   * suite (a rerun inside one suite hides the attempt before it), `filter=all`
   * returns every run; `check_name` and paging are honoured.
   */
  function fakeCheckRunsApi(runsBySha, calls = []) {
    return async (args) => {
      calls.push(args);
      const path = args[0];
      const match = /\/commits\/([^/]+)\/check-runs\?(.*)$/.exec(path);
      if (!match) return {};
      const query = new URLSearchParams(match[2]);
      const all = runsBySha[match[1]] ?? [];
      let runs = query.get("check_name") ? all.filter((r) => r.name === query.get("check_name")) : all;
      if ((query.get("filter") ?? "latest") === "latest") {
        const newest = new Map();
        for (const r of runs) {
          const key = `${r.name}|${r.check_suite?.id ?? r.id}`;
          const seen = newest.get(key);
          if (!seen || String(r.started_at).localeCompare(String(seen.started_at)) > 0) newest.set(key, r);
        }
        runs = [...newest.values()];
      }
      const perPage = Number(query.get("per_page") ?? 30);
      const page = Number(query.get("page") ?? 1);
      return { total_count: runs.length, check_runs: runs.slice((page - 1) * perPage, page * perPage) };
    };
  }
  const run = (id, startedAt, status, conclusion, suite = id) => ({
    id,
    name: "CI result",
    status,
    conclusion,
    started_at: startedAt,
    check_suite: { id: suite },
  });
  const T1 = "2026-11-06T10:00:00Z";
  const T2 = "2026-11-06T10:30:00Z";

  it("reads the real result of the head under a newer skipped label-event run", async () => {
    const port = createGitHubPort(REPO, {
      run: fakeCheckRunsApi({ [HEAD]: [run(1, T1, "completed", "success"), run(2, T2, "completed", "skipped")] }),
    });
    assert.equal(await port.ciConclusion(HEAD), "success");
  });

  it("keeps a failure when a skipped run came after it", async () => {
    const port = createGitHubPort(REPO, {
      run: fakeCheckRunsApi({ [HEAD]: [run(1, T1, "completed", "failure"), run(2, T2, "completed", "skipped")] }),
    });
    assert.equal(await port.ciConclusion(HEAD), "failure");
  });

  it("a head with only a skipped run is pending", async () => {
    const port = createGitHubPort(REPO, { run: fakeCheckRunsApi({ [HEAD]: [run(2, T2, "completed", "skipped")] }) });
    assert.equal(await port.ciConclusion(HEAD), "pending");
  });

  it("cancelled and timed_out heads are not success", async () => {
    for (const conclusion of ["cancelled", "timed_out"]) {
      const port = createGitHubPort(REPO, {
        run: fakeCheckRunsApi({ [HEAD]: [run(1, T1, "completed", "success"), run(2, T2, "completed", conclusion)] }),
      });
      assert.equal(await port.ciConclusion(HEAD), conclusion);
    }
  });

  it("asks GitHub for the CI result runs of the head only, all of them, and follows the pages", async () => {
    const calls = [];
    // 120 skipped runs on top of the one real success: the success is on page 2 of the listing
    const runs = [];
    for (let i = 0; i < 120; i += 1) {
      runs.push(run(100 + i, `2026-11-06T10:${String(i % 60).padStart(2, "0")}:00Z`, "completed", "skipped"));
    }
    runs.push(run(1, "2026-11-06T09:00:00Z", "completed", "success"));
    const port = createGitHubPort(REPO, { run: fakeCheckRunsApi({ [HEAD]: runs }, calls) });
    assert.equal(await port.ciConclusion(HEAD), "success");
    assert.equal(calls.length, 2);
    for (const [url] of calls) {
      assert.match(url, /check_name=CI%20result/);
      assert.match(url, /filter=all/);
    }
    assert.match(calls[1][0], /page=2/);
  });

  it("main with a skipped-only head is not green, the last completed run before it is used", async () => {
    const OLDER = "9".repeat(40);
    const port = createGitHubPort(REPO, {
      run: async (args) => {
        if (args[0].includes("/commits/main")) return { sha: MAIN_HEAD };
        if (args[0].includes("commits?sha=")) return [{ sha: MAIN_HEAD }, { sha: OLDER }];
        return fakeCheckRunsApi({
          [MAIN_HEAD]: [run(2, T2, "completed", "skipped")],
          [OLDER]: [run(1, T1, "completed", "success")],
        })(args);
      },
    });
    const details = await port.mainCiDetails("main");
    assert.equal(details.status, "pending");
    assert.equal(details.lastCompleted, "success");
  });

  it("runOnce labels an approved PR whose real CI result is older than a skipped label-event run", async () => {
    const posted = [];
    const checkRuns = fakeCheckRunsApi({
      [HEAD]: [run(1, T1, "completed", "success"), run(2, T2, "completed", "skipped")],
      [MAIN_HEAD]: [run(3, T1, "completed", "success")],
    });
    const github = createGitHubPort(REPO, {
      run: async (args) => {
        const path = args[0];
        if (args[1] === "-X" || args.includes("-X")) {
          posted.push(args);
          return {};
        }
        if (path.endsWith("/commits/main")) return { sha: MAIN_HEAD };
        if (path.includes("/check-runs")) return checkRuns(args);
        if (path.endsWith("/pulls/2447")) {
          return {
            state: "open",
            draft: false,
            merged: false,
            head: { sha: HEAD },
            base: { sha: MAIN_HEAD, ref: "main", repo: { default_branch: "main" } },
            labels: [],
          };
        }
        if (path.includes("/pulls/2447/files")) return [{ filename: "scripts/myrmidon/review-approve-label.mjs" }];
        if (path.includes("/contents/")) return MAIN_MIGRATIONS.map((file) => ({ type: "file", path: file }));
        throw new Error(`unexpected request ${path}`);
      },
    });
    const { results } = await runOnce({
      comments: [comment(`VERDICT #2447: APPROVE (head ${HEAD})`, "2026-11-06T09:30:00Z")],
      repo: REPO,
      github,
    });
    assert.deepEqual(results.map((r) => [r.prNumber, r.action, r.reason]), [[2447, "label", "approved-head-green"]]);
    assert.deepEqual(posted.at(-1), ["-X", "POST", `repos/${REPO}/issues/2447/labels`, "-f", `labels[]=${APPROVED_LABEL}`]);
  });
});

describe("main / sql", () => {
  it("prints a bounded SQL and rejects a bad window", () => {
    assert.match(boardVerdictSql(24), /interval '24 hours'/);
    assert.throws(() => boardVerdictSql("1; drop table x"), /since-hours/);
  });
  it("is usage error 2 without a source, and reads a psql command result", async () => {
    const quiet = { log() {}, error() {} };
    assert.equal(await main(["--repo", REPO], quiet), 2);
    assert.equal(await main(["--repo", "bad", "--verdicts", "x"], quiet), 2);
    const github = fakeGitHub({ 1: { pr: { state: "open", draft: false, merged: false, headSha: HEAD, labels: [] }, ci: "success" } }, { mainCi: "success" });
    const code = await main(["--repo", REPO, "--psql-cmd", "ignored"], {
      ...quiet,
      github,
      readFromPsql: async () => [comment(`VERDICT #1: APPROVE (head ${HEAD})`, "2026-10-08T07:00:00Z")],
    });
    assert.equal(code, 0);
    assert.deepEqual(github.labeled, [1]);
  });
});
