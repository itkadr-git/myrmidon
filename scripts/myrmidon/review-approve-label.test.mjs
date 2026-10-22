import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVED_LABEL,
  boardVerdictSql,
  createGitHubPort,
  decideApproveLabel,
  latestVerdicts,
  main,
  parseVerdictLines,
  runOnce,
} from "./review-approve-label.mjs";

const REPO = "owner/name";
const HEAD = "bd4b5f8924df56595fde8268885f8f912ff6b262";
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

describe("decideApproveLabel", () => {
  const at = new Date("2026-10-08T07:00:00Z");
  const open = { state: "open", draft: false, merged: false, headSha: HEAD, labels: [] };
  const approve = { outcome: "approve", head: HEAD.slice(0, 12), at };
  it("labels an approved, unchanged, green head", () => {
    assert.equal(decideApproveLabel({ verdict: approve, pr: open, headCommittedAt: null, ci: "success" }).action, "label");
  });
  it("is a no-op when the label is already there", () => {
    assert.equal(decideApproveLabel({ verdict: approve, pr: { ...open, labels: [APPROVED_LABEL] }, headCommittedAt: null, ci: "success" }).action, "noop");
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

function fakeGitHub(prs) {
  const labeled = [];
  return {
    labeled,
    async pullRequest(n) {
      if (!prs[n]) throw new Error("404");
      return prs[n].pr;
    },
    async headCommittedAt() {
      return new Date("2026-10-08T05:00:00Z");
    },
    async ciConclusion(sha) {
      return prs[Object.keys(prs).find((k) => prs[k].pr.headSha === sha)].ci;
    },
    async addLabel(n) {
      labeled.push(n);
    },
  };
}

describe("runOnce", () => {
  const open = (headSha, labels = []) => ({ state: "open", draft: false, merged: false, headSha, labels });
  const comments = [
    comment(`VERDICT #1: APPROVE (head ${HEAD})`, "2026-10-08T07:00:00Z", "adm-dev-review", "a"),
    comment("VERDICT #2: APPROVE", "2026-10-08T07:00:00Z", "adm-dev-review", "b"),
    comment("VERDICT #3: RETURN", "2026-10-08T07:00:00Z", "adm-dev-review", "c"),
    comment("VERDICT #4: APPROVE", "2026-10-08T07:00:00Z", "adm-dev-review", "d"),
  ];
  it("labels only what is approved, current and green, and reports the rest", async () => {
    const github = fakeGitHub({
      1: { pr: open(HEAD), ci: "success" },
      2: { pr: open("a".repeat(40)), ci: "failure" },
      4: { pr: open("b".repeat(40), [APPROVED_LABEL]), ci: "success" },
    });
    const lines = [];
    const { results, failed } = await runOnce({ comments, repo: REPO, github, log: (l) => lines.push(l) });
    assert.deepEqual(github.labeled, [1]);
    assert.equal(failed, 0);
    assert.deepEqual(results.map((r) => [r.prNumber, r.action]), [[1, "label"], [2, "skip"], [3, "skip"], [4, "noop"]]);
  });
  it("does not write in a dry run, and counts a failed GitHub call", async () => {
    const github = fakeGitHub({ 1: { pr: open(HEAD), ci: "success" } });
    const dry = await runOnce({ comments, repo: REPO, github, dryRun: true });
    assert.deepEqual(github.labeled, []);
    assert.equal(dry.results.find((r) => r.prNumber === 1).dryRun, true);
    assert.equal(dry.failed, 2);
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
    const github = fakeGitHub({ 1: { pr: { state: "open", draft: false, merged: false, headSha: HEAD, labels: [] }, ci: "success" } });
    const code = await main(["--repo", REPO, "--psql-cmd", "ignored"], {
      ...quiet,
      github,
      readFromPsql: async () => [comment(`VERDICT #1: APPROVE (head ${HEAD})`, "2026-10-08T07:00:00Z")],
    });
    assert.equal(code, 0);
    assert.deepEqual(github.labeled, [1]);
  });
});
