// myrmidon(OPE-11767): the board merges an approved pull request itself —
// against a fake store and a fake GitHub client. The scenarios are the ones of
// the defect: approved while CI is pending and green later (the gap a host
// script used to cover), approved and green (merged once, never twice), a
// conflict after the approval (back to the implementer, once), and a base the
// board does not merge into.

import { describe, expect, it, vi } from "vitest";
import {
  REVIEW_ROUTING_BOARD_MERGED_ACTION,
  REVIEW_ROUTING_BOARD_MERGE_BLOCKED_ACTION,
  REVIEW_ROUTING_BOARD_MERGE_LABELED_ACTION,
  REVIEW_ROUTING_BOARD_MERGE_REFUSED_ACTION,
  REVIEW_ROUTING_BOARD_MERGE_RETURNED_ACTION,
  normalizeReviewRoutingSettings,
  type ReviewRoutingSettings,
} from "@myrmidon/shared";
import {
  BOARD_MERGE_COOLDOWN_MS,
  BOARD_MERGE_REFUSED_COOLDOWN_MS,
  boardMergeReturnComment,
  createBoardMerger,
  type BoardMerger,
} from "./board-merge.js";
import type { BoardMergeClient, BoardMergeOutcome } from "./github-board-merge.js";
import {
  BOARD_MERGE_FULL_CI_SERVER_SHARD_CHECKS,
  type BoardMergeFacts,
  type RequiredCheckVerdict,
} from "./pr-policy.js";
import type { ApprovedPrIssueRow, ReturnedApprovedPr } from "./store.js";

const COMPANY = "company-1";
const REPO = "acme/widgets";
const HEAD = "28f15c1be15204153f0e06464842d88875c373f8";
const OTHER_HEAD = "0123456789abcdef0123456789abcdef01234567";
const IMPLEMENTER = "aaaaaaaa-0000-4000-8000-000000000009";
const NOW = new Date("2026-11-06T08:00:00Z");

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function facts(overrides: Partial<BoardMergeFacts> = {}): BoardMergeFacts {
  return {
    open: true,
    draft: false,
    headSha: HEAD,
    baseRef: "main",
    mergeable: true,
    mergeableState: "clean",
    labels: [],
    ...overrides,
  };
}

function approved(number: number, overrides: Partial<ApprovedPrIssueRow> = {}): ApprovedPrIssueRow {
  return {
    issueId: `issue-${number}`,
    identifier: `OPE-${number}`,
    title: `Task ${number}`,
    status: "in_review",
    repository: REPO,
    number,
    prUrl: `https://github.com/${REPO}/pull/${number}`,
    verdict: `APPROVE PR #${number} ${HEAD}\n\nExact head, CI complete.`,
    approvedAt: NOW,
    ...overrides,
  };
}

interface PullState {
  facts: BoardMergeFacts;
  checks: RequiredCheckVerdict;
  mergeOutcome?: BoardMergeOutcome;
  files?: readonly string[];
}

function setup(
  rows: ApprovedPrIssueRow[],
  pulls: Record<number, PullState>,
  boardMerge: Partial<ReviewRoutingSettings["boardMerge"]> = {},
  extra: { readFailure?: Record<number, string> } = {},
) {
  const settings = normalizeReviewRoutingSettings({ boardMerge });
  const standing = new Set(rows.map((row) => row.issueId));
  const returnedIssues: string[] = [];
  const calls = {
    readPull: [] as number[],
    readPullFiles: [] as number[],
    readChecks: [] as Array<{ number: number; names: readonly string[] }>,
    label: [] as number[],
    merge: [] as Array<{ number: number; headSha: string; method: string }>,
  };
  const comments: Array<{ issueId: string; body: string }> = [];
  const activities: Array<{ action: string; issueId: string; details: Record<string, unknown> }> = [];
  const wakes: Array<{ agentId: string; issueId: string; reason: string; executionStage: Record<string, unknown> }> = [];

  const client: BoardMergeClient = {
    readPull: async ({ number }) => {
      calls.readPull.push(number);
      const failure = extra.readFailure?.[number];
      if (failure) return { ok: false, reason: failure };
      const state = pulls[number];
      return state ? { ok: true, facts: { ...state.facts } } : { ok: false, reason: "http_404" };
    },
    readPullFiles: async ({ number }) => {
      calls.readPullFiles.push(number);
      const state = pulls[number];
      return { ok: true, files: state?.files ?? [] };
    },
    readChecks: async ({ names, headSha }) => {
      const number = Number(Object.keys(pulls).find((key) => pulls[Number(key)]!.facts.headSha === headSha));
      calls.readChecks.push({ number, names });
      const state = pulls[number];
      if (!state) return { ok: false, reason: "http_404" };
      return { ok: true, checks: Object.fromEntries(names.map((name) => [name, state.checks])) };
    },
    addApprovedLabel: async ({ number, label }) => {
      calls.label.push(number);
      const state = pulls[number]!;
      state.facts = { ...state.facts, labels: [...state.facts.labels, label ?? "review-approved"] };
      return true;
    },
    merge: async ({ number, headSha, method }) => {
      calls.merge.push({ number, headSha, method });
      const state = pulls[number]!;
      if (state.mergeOutcome) return state.mergeOutcome;
      if (state.facts.headSha !== headSha) return { status: "head_moved" };
      if (!state.facts.open) return { status: "refused", httpStatus: 405 };
      state.facts = { ...state.facts, open: false };
      return { status: "merged", sha: "f".repeat(40) };
    },
  };

  const log = { info: vi.fn(), warn: vi.fn() };
  const merger: BoardMerger = createBoardMerger({
    store: {
      listApprovedPrIssues: async (_companyId, options) =>
        rows.filter((row) => standing.has(row.issueId) && (!options?.issueId || row.issueId === options.issueId)),
      returnApprovedPrToImplementer: async ({ issueId }): Promise<ReturnedApprovedPr | null> => {
        if (!standing.has(issueId)) return null; // the approval no longer stands: already sent back
        standing.delete(issueId);
        returnedIssues.push(issueId);
        return {
          implementerAgentId: IMPLEMENTER,
          previousStatus: "in_review",
          executionState: {
            status: "changes_requested",
            currentStageId: "stage-1",
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: "reviewer-1" },
            returnAssignee: { type: "agent", agentId: IMPLEMENTER },
          },
        };
      },
    },
    client,
    addComment: async (issueId, body) => {
      comments.push({ issueId, body });
    },
    wakeAgent: async (agentId, wake) => {
      wakes.push({ agentId, issueId: wake.issueId, reason: wake.reason, executionStage: wake.executionStage });
    },
    logActivity: async (entry) => {
      activities.push({ action: entry.action, issueId: entry.issueId, details: entry.details });
    },
    log,
  });
  return { merger, settings, log, calls, comments, activities, wakes, returnedIssues, pulls };
}

describe("board merge: approved, then CI turns green", () => {
  it("approved while CI is pending: nothing merges; once CI is green the next pass merges it, and never twice", async () => {
    const t = setup([approved(7)], { 7: { facts: facts(), checks: "pending" } });

    const first = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(first).toMatchObject({ evaluated: 1, merged: 0, waiting: 1 });
    expect(t.calls.merge).toEqual([]);

    t.pulls[7]!.checks = "success";
    const second = await t.merger.sweepCompany(COMPANY, t.settings, at(60_000));
    expect(second).toMatchObject({ merged: 1, waiting: 0, failed: 0 });
    // The merge is pinned to the approved head and uses the repository's squash convention.
    expect(t.calls.merge).toEqual([{ number: 7, headSha: HEAD, method: "squash" }]);
    expect(t.calls.readChecks[0]?.names).toEqual(["CI result"]);
    expect(t.activities).toEqual([
      expect.objectContaining({
        action: REVIEW_ROUTING_BOARD_MERGED_ACTION,
        issueId: "issue-7",
        details: expect.objectContaining({ repository: REPO, pullRequest: 7, headSha: HEAD, method: "squash" }),
      }),
    ]);
    expect(t.comments).toEqual([expect.objectContaining({ issueId: "issue-7", body: expect.stringContaining("merged by the board") })]);

    // The PR is closed now: later passes read it and leave it alone.
    const third = await t.merger.sweepCompany(COMPANY, t.settings, at(10 * 60_000));
    expect(third.merged).toBe(0);
    expect(t.calls.merge).toHaveLength(1);
  });

  it("approved and already green: merged at once (event), exactly one merge call even when sweep and event race", async () => {
    const t = setup([approved(8)], { 8: { facts: facts(), checks: "success" } });
    const results = await Promise.all([
      t.merger.mergeIssue(COMPANY, "issue-8", t.settings, at(0)),
      t.merger.sweepCompany(COMPANY, t.settings, at(0)),
      t.merger.mergePullRequest(COMPANY, { repository: REPO, number: 8 }, t.settings, at(0)),
    ]);
    expect(results.reduce((sum, result) => sum + result.merged, 0)).toBe(1);
    expect(t.calls.merge).toHaveLength(1);

    // A repeat event after the merge changes nothing.
    const again = await t.merger.mergeIssue(COMPANY, "issue-8", t.settings, at(1000));
    expect(again.merged).toBe(0);
    expect(t.calls.merge).toHaveLength(1);
  });

  it("a green PR that is merely behind main is merged as it is: the head is never updated after an approval", async () => {
    // `clean` is what GitHub reports for a behind-but-mergeable branch when the repository does not require it to be current.
    const t = setup([approved(9)], { 9: { facts: facts({ mergeableState: "clean" }), checks: "success" } });
    const result = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(result.merged).toBe(1);
    expect(t.calls.merge).toHaveLength(1);
    expect(t.returnedIssues).toEqual([]);
  });

  it("merges with an unstable state (a non-required check is red) and honours a configured method", async () => {
    const t = setup(
      [approved(10)],
      { 10: { facts: facts({ mergeableState: "unstable" }), checks: "success" } },
      { method: "merge" },
    );
    await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(t.calls.merge).toEqual([{ number: 10, headSha: HEAD, method: "merge" }]);
  });

  it("never merges while a required check failed or the mergeability is not computed yet", async () => {
    const failed = setup([approved(11)], { 11: { facts: facts(), checks: "failed" } });
    expect(await failed.merger.sweepCompany(COMPANY, failed.settings, at(0))).toMatchObject({ merged: 0, waiting: 1 });
    expect(failed.calls.merge).toEqual([]);

    const unknown = setup([approved(12)], { 12: { facts: facts({ mergeable: null, mergeableState: "unknown" }), checks: "success" } });
    expect(await unknown.merger.sweepCompany(COMPANY, unknown.settings, at(0))).toMatchObject({ merged: 0, waiting: 1 });
    expect(unknown.calls.readChecks).toEqual([]); // mergeability first: no request is spent on the checks
    expect(unknown.calls.merge).toEqual([]);
  });
});

describe("board merge: conflict after the approval", () => {
  it("returns the task to its implementer once, with the rebase comment, and merges nothing", async () => {
    const t = setup([approved(20)], { 20: { facts: facts({ mergeable: false, mergeableState: "dirty" }), checks: "success" } });

    const first = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(first).toMatchObject({ returned: 1, merged: 0 });
    expect(t.returnedIssues).toEqual(["issue-20"]);
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]!.body).toContain("Конфликт с main после одобрения — нужен rebase");
    expect(t.comments[0]!.body).toContain(`${REPO}#20`);
    expect(t.activities).toEqual([
      expect.objectContaining({
        action: REVIEW_ROUTING_BOARD_MERGE_RETURNED_ACTION,
        issueId: "issue-20",
        details: expect.objectContaining({ reason: "conflict", headSha: HEAD, returnedTo: IMPLEMENTER }),
      }),
    ]);
    expect(t.wakes).toEqual([
      expect.objectContaining({
        agentId: IMPLEMENTER,
        issueId: "issue-20",
        reason: "execution_changes_requested",
        executionStage: expect.objectContaining({ wakeRole: "executor", allowedActions: ["address_changes", "resubmit"] }),
      }),
    ]);
    // A rebase is needed whatever CI says: no check request was spent and nothing was merged.
    expect(t.calls.readChecks).toEqual([]);
    expect(t.calls.merge).toEqual([]);

    // Once per head: the approval no longer stands, later passes and events do not return it again.
    const later = await t.merger.sweepCompany(COMPANY, t.settings, at(BOARD_MERGE_COOLDOWN_MS + 1));
    const event = await t.merger.mergeIssue(COMPANY, "issue-20", t.settings, at(BOARD_MERGE_COOLDOWN_MS + 2));
    expect(later.returned + event.returned).toBe(0);
    expect(t.comments).toHaveLength(1);
    expect(t.wakes).toHaveLength(1);
  });

  it("a head behind main that the repository requires to be current goes back for a rebase as well", async () => {
    const t = setup([approved(21)], { 21: { facts: facts({ mergeableState: "behind" }), checks: "success" } });
    const result = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(result).toMatchObject({ returned: 1, merged: 0 });
    expect(t.activities[0]).toMatchObject({ action: REVIEW_ROUTING_BOARD_MERGE_RETURNED_ACTION, details: expect.objectContaining({ reason: "behind" }) });
    expect(t.comments[0]!.body).toContain("нужен rebase");
    expect(t.calls.merge).toEqual([]);
  });

  it("the comment names the rebase in both languages", () => {
    const body = boardMergeReturnComment({ reason: "conflict", repository: REPO, number: 5, headSha: HEAD, baseRef: "main" });
    expect(body).toContain("Конфликт с main после одобрения — нужен rebase");
    expect(body).toContain("Conflict with main after approval — a rebase is needed");
    expect(body).toContain(HEAD.slice(0, 12));
  });
});

describe("board merge: what it must not merge", () => {
  it("a base other than main is never merged (and costs no check request)", async () => {
    const t = setup([approved(30)], { 30: { facts: facts({ baseRef: "rel/1.6.6" }), checks: "success" } });
    const result = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(result).toMatchObject({ merged: 0, returned: 0 });
    expect(t.calls.merge).toEqual([]);
    expect(t.calls.readChecks).toEqual([]);
  });

  it("a configured release base is merged into", async () => {
    const t = setup(
      [approved(31)],
      { 31: { facts: facts({ baseRef: "rel/1.6.6" }), checks: "success" } },
      { baseBranches: ["main", "rel/1.6.6"] },
    );
    expect((await t.merger.sweepCompany(COMPANY, t.settings, at(0))).merged).toBe(1);
  });

  it("an approval is never carried to a new head: the verdict names another commit, the task goes back to resubmit", async () => {
    const t = setup(
      [approved(32, { verdict: `APPROVE PR #32 ${OTHER_HEAD}` })],
      { 32: { facts: facts(), checks: "success" } },
    );
    const result = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    // myrmidon(HEAD-MOVED-RETURN): never merged, and no longer a silent wait — returned to the implementer.
    expect(result).toMatchObject({ merged: 0, returned: 1 });
    expect(t.calls.merge).toEqual([]);
    expect(t.calls.readChecks).toEqual([]);
    expect(t.activities).toContainEqual(
      expect.objectContaining({ details: expect.objectContaining({ reason: "head_moved", headSha: HEAD }) }),
    );
  });

  it("a verdict that names no head covers no head", async () => {
    const t = setup([approved(33, { verdict: "APPROVE, looks good" })], { 33: { facts: facts(), checks: "success" } });
    await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(t.calls.merge).toEqual([]);
  });

  it("a closed, merged or draft PR is left alone", async () => {
    const t = setup(
      [approved(34), approved(35)],
      {
        34: { facts: facts({ open: false }), checks: "success" },
        35: { facts: facts({ draft: true, mergeableState: "draft" }), checks: "success" },
      },
    );
    await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(t.calls.merge).toEqual([]);
  });

  it("is inert when switched off, or when the repository is outside the configured list", async () => {
    const off = setup([approved(36)], { 36: { facts: facts(), checks: "success" } }, { enabled: false });
    expect(await off.merger.sweepCompany(COMPANY, off.settings, at(0))).toMatchObject({ evaluated: 0, merged: 0 });
    expect(await off.merger.mergeIssue(COMPANY, "issue-36", off.settings, at(0))).toMatchObject({ evaluated: 0, merged: 0 });
    expect(off.calls.readPull).toEqual([]);

    const scoped = setup([approved(37)], { 37: { facts: facts(), checks: "success" } }, { repositories: ["acme/other"] });
    await scoped.merger.sweepCompany(COMPANY, scoped.settings, at(0));
    expect(scoped.calls.readPull).toEqual([]);
    expect(scoped.calls.merge).toEqual([]);
  });
});

describe("board merge: limits, refusals and the review marker", () => {
  it("merges at most maxMergesPerPass per pass; the rest go first on the next pass", async () => {
    const rows = [approved(40), approved(41), approved(42)];
    const pulls = Object.fromEntries(rows.map((row) => [row.number, { facts: facts(), checks: "success" as const }]));
    const t = setup(rows, pulls, { maxMergesPerPass: 2 });

    const first = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(first).toMatchObject({ merged: 2, waiting: 1 });
    expect(t.calls.merge.map((call) => call.number)).toEqual([40, 41]);

    const second = await t.merger.sweepCompany(COMPANY, t.settings, at(60_000));
    expect(second.merged).toBe(1);
    expect(t.calls.merge.map((call) => call.number)).toEqual([40, 41, 42]);
  });

  it("a merge GitHub refuses (405) rests for the cool-down, then is tried again; an event bypasses the rest", async () => {
    const t = setup([approved(50)], { 50: { facts: facts(), checks: "success", mergeOutcome: { status: "refused", httpStatus: 405 } } });
    await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    await t.merger.sweepCompany(COMPANY, t.settings, at(60_000));
    expect(t.calls.merge).toHaveLength(1);

    await t.merger.sweepCompany(COMPANY, t.settings, at(BOARD_MERGE_REFUSED_COOLDOWN_MS + 1));
    expect(t.calls.merge).toHaveLength(2);

    await t.merger.mergePullRequest(COMPANY, { repository: REPO, number: 50 }, t.settings, at(BOARD_MERGE_REFUSED_COOLDOWN_MS + 2));
    expect(t.calls.merge).toHaveLength(3);
    // Nothing was merged, nothing is claimed; myrmidon(OPE-13136): GitHub's refusal is recorded once (throttled), not per attempt.
    expect(t.activities.map((entry) => entry.action)).toEqual([REVIEW_ROUTING_BOARD_MERGE_REFUSED_ACTION]);
  });

  it("myrmidon(OPE-13136): a refused merge puts the HTTP status and GitHub's message on the task, once", async () => {
    const message = "Required status check \"hot files review\" is expected.";
    const t = setup([approved(53)], {
      53: { facts: facts(), checks: "success", mergeOutcome: { status: "refused", httpStatus: 405, message } },
    });
    await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    await t.merger.sweepCompany(COMPANY, t.settings, at(BOARD_MERGE_REFUSED_COOLDOWN_MS + 1));
    expect(t.calls.merge).toHaveLength(2);
    expect(t.activities).toEqual([
      {
        action: REVIEW_ROUTING_BOARD_MERGE_REFUSED_ACTION,
        issueId: "issue-53",
        details: { repository: REPO, pullRequest: 53, headSha: HEAD, httpStatus: 405, message },
      },
    ]);
  });

  it("blocked only by the missing review marker: puts the marker, then merges once the gate is green", async () => {
    const t = setup([approved(51)], { 51: { facts: facts({ mergeableState: "blocked" }), checks: "success" } });
    const first = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(first).toMatchObject({ labeled: 1, merged: 0 });
    expect(t.calls.label).toEqual([51]);
    expect(t.activities[0]).toMatchObject({ action: REVIEW_ROUTING_BOARD_MERGE_LABELED_ACTION, issueId: "issue-51" });

    // The hot-files workflow turned green on the label: GitHub now reports the PR clean.
    t.pulls[51]!.facts = { ...t.pulls[51]!.facts, mergeableState: "clean" };
    const second = await t.merger.sweepCompany(COMPANY, t.settings, at(BOARD_MERGE_COOLDOWN_MS + 1));
    expect(second.merged).toBe(1);
    expect(t.calls.label).toEqual([51]);
  });

  it("blocked with the marker present waits and does not label again", async () => {
    const t = setup([approved(52)], { 52: { facts: facts({ mergeableState: "blocked", labels: ["review-approved"] }), checks: "success" } });
    const result = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(result).toMatchObject({ merged: 0, labeled: 0, waiting: 1 });
    expect(t.calls.label).toEqual([]);
  });
});

describe("myrmidon(OPE-13136): a PR that stays BLOCKED with green checks is reported", () => {
  const MINUTE = 60_000;
  const blockedPull = (overrides: Partial<BoardMergeFacts> = {}): PullState => ({
    facts: facts({ mergeableState: "blocked", labels: ["review-approved"], ...overrides }),
    checks: "success",
  });
  const blockedActivities = (t: ReturnType<typeof setup>) =>
    t.activities.filter((entry) => entry.action === REVIEW_ROUTING_BOARD_MERGE_BLOCKED_ACTION);

  it("beyond the threshold: exactly one activity and one warning, none on the next pass", async () => {
    const t = setup([approved(60)], { 60: blockedPull() });
    await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    await t.merger.sweepCompany(COMPANY, t.settings, at(29 * MINUTE));
    expect(blockedActivities(t)).toEqual([]);
    expect(t.log.warn).not.toHaveBeenCalled();

    await t.merger.sweepCompany(COMPANY, t.settings, at(31 * MINUTE));
    expect(blockedActivities(t)).toEqual([
      {
        action: REVIEW_ROUTING_BOARD_MERGE_BLOCKED_ACTION,
        issueId: "issue-60",
        details: {
          repository: REPO,
          pullRequest: 60,
          headSha: HEAD,
          minutesBlocked: 31,
          requiredChecks: ["CI result"],
          message: "GitHub reports the pull request BLOCKED although the required checks are green",
        },
      },
    ]);
    expect(t.log.warn).toHaveBeenCalledTimes(1);

    await t.merger.sweepCompany(COMPANY, t.settings, at(40 * MINUTE));
    await t.merger.sweepCompany(COMPANY, t.settings, at(120 * MINUTE));
    expect(blockedActivities(t)).toHaveLength(1);
    expect(t.log.warn).toHaveBeenCalledTimes(1);
  });

  it("a head change resets the count: the alert fires 30 minutes after the NEW head was first seen blocked", async () => {
    const rows = [approved(61)];
    const t = setup(rows, { 61: blockedPull() });
    await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    await t.merger.sweepCompany(COMPANY, t.settings, at(20 * MINUTE));

    // A new head, approved again (the verdict names it): the clock starts over.
    t.pulls[61]!.facts = { ...t.pulls[61]!.facts, headSha: OTHER_HEAD };
    rows[0]!.verdict = `APPROVE PR #61 ${OTHER_HEAD}\n\nExact head, CI complete.`;
    await t.merger.sweepCompany(COMPANY, t.settings, at(25 * MINUTE));
    await t.merger.sweepCompany(COMPANY, t.settings, at(31 * MINUTE)); // 31 min since the first head, 6 since the new one
    expect(blockedActivities(t)).toEqual([]);
    await t.merger.sweepCompany(COMPANY, t.settings, at(56 * MINUTE));
    expect(blockedActivities(t)).toHaveLength(1);
    expect(blockedActivities(t)[0]!.details).toMatchObject({ headSha: OTHER_HEAD, minutesBlocked: 31 });
  });

  it("a PR that stops being blocked forgets the spell: the later block counts from its own start", async () => {
    const t = setup([approved(62)], { 62: blockedPull() });
    await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    await t.merger.sweepCompany(COMPANY, t.settings, at(20 * MINUTE));
    // GitHub is recomputing the mergeability: not "blocked" for a while.
    t.pulls[62]!.facts = { ...t.pulls[62]!.facts, mergeable: null, mergeableState: "unknown" };
    await t.merger.sweepCompany(COMPANY, t.settings, at(25 * MINUTE));
    t.pulls[62]!.facts = { ...t.pulls[62]!.facts, mergeable: true, mergeableState: "blocked" };
    await t.merger.sweepCompany(COMPANY, t.settings, at(30 * MINUTE)); // the new spell starts here
    await t.merger.sweepCompany(COMPANY, t.settings, at(55 * MINUTE)); // 25 min into it
    expect(blockedActivities(t)).toEqual([]);
    await t.merger.sweepCompany(COMPANY, t.settings, at(61 * MINUTE)); // 31 min into it
    expect(blockedActivities(t)).toHaveLength(1);
  });

  it("blockedAlertAfterMinutes 0 switches the alert off", async () => {
    const t = setup([approved(64)], { 64: blockedPull() }, { blockedAlertAfterMinutes: 0 });
    await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    await t.merger.sweepCompany(COMPANY, t.settings, at(600 * MINUTE));
    expect(blockedActivities(t)).toEqual([]);
    expect(t.log.warn).not.toHaveBeenCalled();
  });
});

describe("board merge: GitHub trouble never guesses", () => {
  it("no identity for the repository is silent and rests; a read error is counted; a rate limit stops the pass", async () => {
    const t = setup(
      [approved(60), approved(61), approved(62)],
      {
        60: { facts: facts(), checks: "success" },
        61: { facts: facts(), checks: "success" },
        62: { facts: facts(), checks: "success" },
      },
      {},
      { readFailure: { 60: "no_token", 61: "http_502", 62: "rate_limited" } },
    );
    const result = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(result).toMatchObject({ evaluated: 0, merged: 0, failed: 1 });
    expect(t.calls.readPull).toEqual([60, 61, 62]);
    expect(t.calls.merge).toEqual([]);

    // The pull requests that failed to read rest for the cool-down; the rate-limited one is asked again.
    await t.merger.sweepCompany(COMPANY, t.settings, at(60_000));
    expect(t.calls.readPull).toEqual([60, 61, 62, 62]);
  });

  it("a merge call that failed outright is counted and not repeated within the cool-down", async () => {
    const t = setup([approved(63)], { 63: { facts: facts(), checks: "success", mergeOutcome: { status: "failed", reason: "http_403" } } });
    expect(await t.merger.sweepCompany(COMPANY, t.settings, at(0))).toMatchObject({ merged: 0, failed: 1 });
    await t.merger.sweepCompany(COMPANY, t.settings, at(30_000));
    expect(t.calls.merge).toHaveLength(1);
  });

  it("the head moving between the read and the merge is refused by GitHub, not merged", async () => {
    const t = setup([approved(64)], {
      64: { facts: facts(), checks: "success", mergeOutcome: { status: "head_moved" } },
    });
    const result = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(result).toMatchObject({ merged: 0, waiting: 1 });
    expect(t.activities).toEqual([]);
  });

  it("a failure in the comment or activity write never undoes or repeats the merge", async () => {
    const t = setup([approved(65)], { 65: { facts: facts(), checks: "success" } });
    const failing = createBoardMerger({
      store: {
        listApprovedPrIssues: async () => [approved(65)],
        returnApprovedPrToImplementer: async () => null,
      },
      client: {
        readPull: async () => ({ ok: true, facts: facts() }),
        readChecks: async () => ({ ok: true, checks: { "CI result": "success" } }),
        addApprovedLabel: async () => true,
        merge: async () => ({ status: "merged", sha: null }),
      },
      addComment: async () => {
        throw new Error("comment store down");
      },
      wakeAgent: async () => undefined,
      logActivity: async () => {
        throw new Error("activity store down");
      },
      log: { info: vi.fn(), warn: vi.fn() },
    });
    const result = await failing.sweepCompany(COMPANY, t.settings, at(0));
    expect(result).toMatchObject({ merged: 1, failed: 0 });
  });

  it("applies full-ci label and requires full shard checks for PRs touching server/src", async () => {
    const t = setup([approved(70)], {
      70: {
        facts: facts(),
        checks: "success",
        files: ["server/src/myrmidon/review-routing/board-merge.ts"],
      },
    });
    const first = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(first).toMatchObject({ labeled: 1, merged: 0 });
    expect(t.calls.label).toEqual([70]);
    expect(t.calls.merge).toEqual([]);

    // Next pass after cooldown: label is present, checks are read with the
    // full six-shard set (OPE-12551: only shard 1 was required before, so a PR
    // failing shard 2-6 merged on a green shard 1).
    const second = await t.merger.sweepCompany(COMPANY, t.settings, at(10 * 60_000));
    expect(second).toMatchObject({ merged: 1 });
    expect(t.calls.readChecks).toEqual([
      { number: 70, names: ["CI result", ...BOARD_MERGE_FULL_CI_SERVER_SHARD_CHECKS] },
    ]);
  });

  it("waits when one of the six server shards fails instead of merging", async () => {
    const t = setup([approved(71)], {
      71: {
        facts: { ...facts(), labels: ["full-ci"] },
        checks: "failed",
        files: ["server/src/myrmidon/review-routing/board-merge.ts"],
      },
    });
    const result = await t.merger.sweepCompany(COMPANY, t.settings, at(0));
    expect(result).toMatchObject({ merged: 0, waiting: 1 });
    expect(t.calls.label).toEqual([]);
    expect(t.calls.merge).toEqual([]);
    expect(t.calls.readChecks).toEqual([
      { number: 71, names: ["CI result", ...BOARD_MERGE_FULL_CI_SERVER_SHARD_CHECKS] },
    ]);
  });
});
