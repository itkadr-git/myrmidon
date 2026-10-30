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
  latestVerdicts,
  main,
  parseVerdictLines,
  runOnce,
} from "./review-approve-label.mjs";

const REPO = "owner/name";
const HEAD = "bd4b5f8924df56595fde8268885f8f912ff6b262";
const MAIN_HEAD = "1111222233334444555566667777888899990000";
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

  it("holds merge when main CI is failure (red main)", () => {
    const decision = decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "success", mainCi: "failure" });
    assert.equal(decision.action, "hold");
    assert.equal(decision.reason, "main-red");
  });

  it("holds merge when main CI is pending or missing", () => {
    assert.deepEqual(decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "success", mainCi: "in_progress" }), {
      action: "hold",
      reason: "main-in_progress",
    });
    assert.deepEqual(decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "success", mainCi: "missing" }), {
      action: "hold",
      reason: "main-missing",
    });
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
    assert.equal(decideApproveLabel({ verdict: approve, pr: { ...open, state: "closed" }, headCommittedAt: null, ci: "success" }).reason, "pr-not-open");
    assert.equal(decideApproveLabel({ verdict: approve, pr: { ...open, merged: true }, headCommittedAt: null, ci: "success" }).reason, "pr-not-open");
    assert.equal(decideApproveLabel({ verdict: approve, pr: { ...open, draft: true }, headCommittedAt: null, ci: "success" }).reason, "pr-draft");
  });
});

function fakeGitHub(prs, { mainCi = "success", mainHeadSha = MAIN_HEAD } = {}) {
  const labeled = [];
  const autoMerged = [];
  const autoDisabled = [];
  return {
    labeled,
    autoMerged,
    autoDisabled,
    async pullRequest(n) {
      if (!prs[n]) throw new Error("404");
      return prs[n].pr;
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
  const open = (headSha, labels = [], autoMerge = false) => ({ state: "open", draft: false, merged: false, headSha, labels, autoMerge });
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

  // Acceptance Criterion 1: test main красный -> без merge
  it("acceptance: holds merge when main CI is red (failure), increments backoff and performs no label/merge", async () => {
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
    assert.equal(consecutiveFailures, 1);
    assert.equal(backoffUntil, "2026-10-30T10:00:30.000Z");
    assert.deepEqual(github.labeled, [], "No labels should be added when main is red");
    assert.deepEqual(github.autoMerged, [], "No auto-merge should be enabled when main is red");

    const r1 = results.find((r) => r.prNumber === 1);
    assert.equal(r1.action, "hold");
    assert.equal(r1.reason, "main-red");

    const saved = await store.load();
    assert.equal(saved.consecutiveFailures, 1);
    assert.equal(saved.mainStatus, "failure");
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

  it("skips merge cycle during active backoff window", async () => {
    const future = new Date("2026-10-30T10:05:00Z").toISOString();
    const store = createMemoryStateStore({
      consecutiveFailures: 2,
      backoffUntil: future,
      mainStatus: "failure",
    });
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
    }, { mainCi: "failure" });

    const now = new Date("2026-10-30T10:01:00Z");
    const { paused, backoffUntil } = await runOnce({
      comments,
      repo: REPO,
      github,
      stateStore: store,
      now,
    });

    assert.equal(paused, true);
    assert.equal(backoffUntil, future);
    assert.deepEqual(github.labeled, []);
  });

  it("does not write in a dry run, and counts a failed GitHub call", async () => {
    const github = fakeGitHub({ 1: { pr: open(HEAD), ci: "success" } }, { mainCi: "success" });
    const dry = await runOnce({ comments, repo: REPO, github, dryRun: true });
    assert.deepEqual(github.labeled, []);
    assert.equal(dry.results.find((r) => r.prNumber === 1).dryRun, true);
    assert.equal(dry.failed, 2);
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
