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

  it("does not label or merge when CI result is skipped", () => {
    const decision = decideApproveLabel({
      verdict: approve,
      pr: open,
      headCommittedAt: null,
      ci: "skipped",
      autoMerge: true,
    });
    assert.deepEqual(decision, { action: "skip", reason: "ci-skipped" });
  });
  it("holds auto-merge when main CI is cancelled or timed out", () => {
    for (const mainCi of ["cancelled", "timed_out"]) {
      const decision = decideApproveLabel({
        verdict: approve,
        pr: { ...open, labels: [APPROVED_LABEL], autoMerge: true },
        headCommittedAt: null,
        ci: "success",
        mainCi,
        autoMerge: true,
      });
      assert.deepEqual(decision, { action: "hold", disableAutoMerge: true, reason: "main-red" });
    }
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

function fakeGitHub(prs, { mainCi = "success", mainHeadSha = MAIN_HEAD, lastCompletedMain = null } = {}) {
  const labeled = [];
  const autoMerged = [];
  const autoDisabled = [];
  const removedLabels = [];
  const updatedBranches = [];
  return {
    labeled,
    autoMerged,
    autoDisabled,
    removedLabels,
    updatedBranches,
    async pullRequest(n) {
      if (!prs[n]) throw new Error("404");
      return prs[n].pr;
    },
    async pullRequestFiles(n) {
      return prs[n]?.files ?? [];
    },
    async mainMigrationFiles() {
      return MAIN_MIGRATIONS;
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
    async enableAutoMerge(n) {
      autoMerged.push(n);
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
    await port.enableAutoMerge(42);
    assert.deepEqual(prCalls[0], ["merge", "42", "-R", REPO, "--auto", "--squash"]);
    await port.disableAutoMerge(42);
    assert.deepEqual(prCalls[1], ["merge", "42", "-R", REPO, "--disable-auto"]);
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
