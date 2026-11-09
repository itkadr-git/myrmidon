// @vitest-environment node
//
// myrmidon(REVIEW-REWORK): the acceptance of the loop end-to-end through fake
// seams — RETURN opens a rework with an executor and blocks the review; a new
// PR head releases the review to todo and wakes the reviewer; a merged PR
// closes the review. Plus the pass gates (interval, maintenance, settings off)
// and the reopen path. No database, no network: the store, the resolver and
// the wake port are all in-memory.

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_REWORK_SWEEP_INTERVAL_SEC,
  REVIEW_REWORK_ACCEPTANCE_ACTION,
  REVIEW_REWORK_BLOCKED_ACTION,
  REVIEW_REWORK_CLOSED_ACTION,
  REVIEW_REWORK_CREATED_ACTION,
  REVIEW_REWORK_UNBLOCKED_ACTION,
  REVIEW_REWORK_WAKE_REASON,
  type ReviewReworkSettings,
} from "@myrmidon/shared";
import { resetGitHubRateLimitForTests, setGitHubRateLimitForTests } from "../../services/github-rate-limit.js";
import {
  createReviewReworkSweep,
  extractPrCoordinates,
  type ReviewReworkSweepDeps,
} from "./sweep.js";
import type { CreateReworkTaskInput, ReworkCandidateRow, ReviewReworkStore } from "./store.js";
import type { ReviewReworkChildFacts, ReviewReworkTaskFacts } from "./domain.js";
import type { ReviewReworkPrResolver, ReviewReworkPrSnapshot } from "./resolver.js";

const VERDICT_AT = "2026-10-04T16:57:32.000Z";
const PR_URL = "https://github.com/acme/repo/pull/484";
const HEAD_OLD = "da3364a2973ee31f0db15e9f5d6492f91880786c";
const HEAD_NEW = "b01958f1e6d4a3c9d7b2f8a1e6d4a3c9d7b2f8a1";

function reviewTask(overrides: Partial<ReviewReworkTaskFacts> = {}): ReviewReworkTaskFacts {
  return {
    id: "review-1",
    companyId: "company-1",
    identifier: "OPE-4417",
    title: `Review PR ${PR_URL}`,
    status: "todo",
    assigneeAgentId: "reviewer-agent",
    assigneeUserId: null,
    projectId: null,
    goalId: null,
    billingCode: null,
    priority: "high",
    returnAssigneeAgentId: "author-agent",
    ...overrides,
  };
}

class FakeStore implements ReviewReworkStore {
  rows: ReworkCandidateRow[] = [];
  comments: Array<{ id: string; body: string; createdAt: Date }> = [];
  child: ReviewReworkChildFacts | null = null;
  created: CreateReworkTaskInput[] = [];
  blocked: Array<{ issueId: string; reworkIssueId: string; comment: string }> = [];
  unblocked: Array<{ issueId: string; comment: string }> = [];
  closed: Array<{ issueId: string; comment: string }> = [];
  stamped: Array<{ issueId: string; originFingerprint: string }> = [];
  reopened: Array<{ issueId: string; originFingerprint: string }> = [];
  deliveringAssignee: string | null = null;
  invokable = new Set<string>(["author-agent", "reviewer-agent", "deliverer-agent", "fallback-agent"]);

  async listActiveCompanyIds() {
    return ["company-1"];
  }
  async listCandidateTasks() {
    return this.rows;
  }
  async listComments() {
    return this.comments;
  }
  async findReworkChild() {
    return this.child;
  }
  async deliveringTaskAssignee() {
    return this.deliveringAssignee;
  }
  async invokableAgentIds(_companyId: string, agentIds: readonly string[]) {
    return new Set(agentIds.filter((id) => this.invokable.has(id)));
  }
  async createReworkTask(input: CreateReworkTaskInput) {
    this.created.push(input);
    return { id: "rework-new", identifier: "OPE-4502" };
  }
  async blockReviewTask(input: { issueId: string; reworkIssueId: string; comment: string }) {
    this.blocked.push(input);
    return true;
  }
  async unblockReviewTask(input: { issueId: string; comment: string }) {
    this.unblocked.push(input);
    return true;
  }
  async closeReviewTask(input: { issueId: string; comment: string }) {
    this.closed.push(input);
    return true;
  }
  reopenedAfterLoopCloseResult = false;
  awaited: Array<{ issueId: string; assigneeAgentId: string | null; comment: string }> = [];
  async reopenedAfterLoopClose(_companyId: string, _issueId: string) {
    return this.reopenedAfterLoopCloseResult;
  }
  async awaitAcceptance(input: { issueId: string; companyId: string; expectStatus: string; assigneeAgentId: string | null; comment: string }) {
    this.awaited.push({ issueId: input.issueId, assigneeAgentId: input.assigneeAgentId, comment: input.comment });
    return true;
  }
  async stampReworkFingerprint(input: { issueId: string; originFingerprint: string }) {
    this.stamped.push(input);
    return true;
  }
  async reopenReworkTask(input: { issueId: string; originFingerprint: string }) {
    this.reopened.push(input);
    return true;
  }
}

function candidateRow(task: ReviewReworkTaskFacts): ReworkCandidateRow {
  return {
    task,
    textParts: [task.title, ""],
    products: [{ repo: "acme/repo", number: 484, url: PR_URL, status: "active" }],
  };
}

function verdictComment() {
  return [{ id: "c-1", body: `VERDICT #484: RETURN (head ${HEAD_OLD})`, createdAt: new Date(VERDICT_AT) }];
}

interface WakeCall {
  agentId: string;
  wake: { reason: string; payload: Record<string, unknown>; idempotencyKey?: string; contextSnapshot: Record<string, unknown> };
}

function build(input: {
  store: FakeStore;
  snapshot: ReviewReworkPrSnapshot | null;
  settings?: Partial<ReviewReworkSettings>;
  maintenance?: boolean;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
  isLeader?: () => boolean;
}) {
  const wakes: WakeCall[] = [];
  const activities: Array<{ action: string; details: Record<string, unknown> }> = [];
  let resolveCalls = 0;
  const resolvePr: ReviewReworkPrResolver = async () => {
    resolveCalls += 1;
    return input.snapshot ?? { state: "unknown", headSha: null, reviewDecision: null, updatedAt: null };
  };
  const deps: ReviewReworkSweepDeps = {
    store: input.store,
    resolvePr,
    readSettings: async () => ({
      enabled: true,
      sweepIntervalSec: DEFAULT_REVIEW_REWORK_SWEEP_INTERVAL_SEC,
      fallbackAssigneeAgentId: null,
      ...input.settings,
    }),
    enqueueWake: async (agentId, wake) => {
      wakes.push({ agentId, wake: wake as WakeCall["wake"] });
    },
    logActivity: async (entry) => {
      activities.push({ action: entry.action, details: entry.details });
    },
    isUnderMaintenance: async () => input.maintenance ?? false,
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.isLeader === undefined ? {} : { isLeader: input.isLeader }),
  };
  return { sweep: createReviewReworkSweep(deps), wakes, activities, getResolveCalls: () => resolveCalls };
}

describe("review rework sweep", () => {
  afterEach(() => {
    resetGitHubRateLimitForTests();
  });
  it("acceptance 1: RETURN opens a rework task with the PR author and blocks the review", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask())];
    store.comments = verdictComment();
    const { sweep, wakes, activities } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-04T17:00:00Z"), { force: true });

    expect(result.reworkCreated).toBe(1);
    expect(result.blocked).toBe(1);
    expect(store.created).toHaveLength(1);
    const create = store.created[0]!;
    expect(create.assigneeAgentId).toBe("author-agent");
    expect(create.parentId).toBe("review-1");
    expect(create.originFingerprint).toBe(`acme/repo#484@${HEAD_OLD}`);
    expect(create.description).toContain(VERDICT_AT);
    expect(create.description).toContain("acme/repo#484");

    expect(store.blocked).toHaveLength(1);
    expect(store.blocked[0]!.issueId).toBe("review-1");
    expect(store.blocked[0]!.reworkIssueId).toBe("rework-new");

    // The new rework executor is woken through the assignment path.
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe("author-agent");
    expect(wakes[0]!.wake.reason).toBe("issue_assigned");

    expect(activities.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([REVIEW_REWORK_CREATED_ACTION, REVIEW_REWORK_BLOCKED_ACTION]),
    );
  });

  it("falls to the delivering task's assignee when the return assignee is gone", async () => {
    const store = new FakeStore();
    store.invokable = new Set(["deliverer-agent", "reviewer-agent"]); // author archived
    store.rows = [candidateRow(reviewTask())];
    store.comments = verdictComment();
    store.deliveringAssignee = "deliverer-agent";
    const { sweep, wakes } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    await sweep.sweep(new Date("2026-10-04T17:00:00Z"), { force: true });

    expect(store.created[0]!.assigneeAgentId).toBe("deliverer-agent");
    expect(wakes[0]!.agentId).toBe("deliverer-agent");
  });

  it("with nobody invokable the rework is created unassigned — the role queue claims it", async () => {
    const store = new FakeStore();
    store.invokable = new Set();
    store.rows = [candidateRow(reviewTask())];
    store.comments = verdictComment();
    const { sweep, wakes } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    await sweep.sweep(new Date("2026-10-04T17:00:00Z"), { force: true });

    expect(store.created[0]!.assigneeAgentId).toBeNull();
    expect(wakes).toHaveLength(0);
  });

  it("acceptance 2: a new head releases the blocked review to todo and wakes the reviewer", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask({ status: "blocked" }))];
    store.comments = verdictComment();
    store.child = {
      id: "rework-1",
      identifier: "OPE-4502",
      status: "todo",
      assigneeAgentId: "author-agent",
      prKey: "acme/repo#484",
      baselineHeadSha: HEAD_OLD,
    };
    const { sweep, wakes, activities } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_NEW, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-05T08:00:00Z"), { force: true });

    expect(result.unblocked).toBe(1);
    expect(store.unblocked).toHaveLength(1);
    expect(store.unblocked[0]!.comment).toContain("HEAD-ACK acme/repo#484");
    expect(store.unblocked[0]!.comment).toContain(HEAD_NEW);

    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe("reviewer-agent");
    expect(wakes[0]!.wake.reason).toBe(REVIEW_REWORK_WAKE_REASON);
    expect(wakes[0]!.wake.payload.issueId).toBe("review-1");

    expect(activities.map((entry) => entry.action)).toContain(REVIEW_REWORK_UNBLOCKED_ACTION);
  });

  it("an unchanged head keeps the review blocked and wakes nobody", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask({ status: "blocked" }))];
    store.comments = verdictComment();
    store.child = {
      id: "rework-1",
      identifier: "OPE-4502",
      status: "todo",
      assigneeAgentId: "author-agent",
      prKey: "acme/repo#484",
      baselineHeadSha: HEAD_OLD,
    };
    const { sweep, wakes } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-05T08:00:00Z"), { force: true });

    expect(result.unblocked).toBe(0);
    expect(store.unblocked).toHaveLength(0);
    expect(wakes).toHaveLength(0);
  });

  it("a verdict that pinned no head stores the baseline first, then releases on the move", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask({ status: "blocked" }))];
    store.comments = [{ id: "c-1", body: "VERDICT #484: RETURN", createdAt: new Date(VERDICT_AT) }];
    store.child = {
      id: "rework-1",
      identifier: "OPE-4502",
      status: "todo",
      assigneeAgentId: "author-agent",
      prKey: "acme/repo#484",
      baselineHeadSha: null,
    };
    const first = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });
    const resultA = await first.sweep.sweep(new Date("2026-10-05T08:00:00Z"), { force: true });
    expect(resultA.baselinesRecorded).toBe(1);
    expect(store.stamped[0]!.originFingerprint).toBe(`acme/repo#484@${HEAD_OLD}`);
    expect(store.unblocked).toHaveLength(0);

    // The author pushes; the head moves past the freshly stored baseline.
    store.child = { ...store.child!, baselineHeadSha: HEAD_OLD };
    const second = build({
      store,
      snapshot: { state: "open", headSha: HEAD_NEW, reviewDecision: null, updatedAt: null },
    });
    const resultB = await second.sweep.sweep(new Date("2026-10-05T08:01:00Z"), { force: true });
    expect(resultB.unblocked).toBe(1);
    expect(second.wakes[0]!.wake.reason).toBe(REVIEW_REWORK_WAKE_REASON);
  });

  it("acceptance 3: a merged PR closes the review task", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask({ status: "in_review" }))];
    store.comments = verdictComment();
    const { sweep, activities } = build({
      store,
      snapshot: { state: "merged", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-05T09:00:00Z"), { force: true });

    expect(result.closed).toBe(1);
    expect(store.closed).toHaveLength(1);
    expect(store.closed[0]!.issueId).toBe("review-1");
    expect(activities.map((entry) => entry.action)).toContain(REVIEW_REWORK_CLOSED_ACTION);
    // The closed review creates no rework.
    expect(store.created).toHaveLength(0);
  });

  it("OPE-12260: a task reopened by a person after the loop closed it is handed back for acceptance, not closed again", async () => {
    const store = new FakeStore();
    store.reopenedAfterLoopCloseResult = true;
    store.rows = [candidateRow(reviewTask({ status: "in_review" }))];
    store.comments = verdictComment();
    const { sweep, activities } = build({
      store,
      snapshot: { state: "merged", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-05T09:00:00Z"), { force: true });

    expect(result.closed).toBe(0);
    expect(result.awaitedAcceptance).toBe(1);
    expect(store.closed).toHaveLength(0);
    expect(store.awaited).toHaveLength(1);
    expect(store.awaited[0]!.issueId).toBe("review-1");
    expect(store.awaited[0]!.assigneeAgentId).toBe("author-agent");
    expect(store.awaited[0]!.comment).toContain("acceptance pending");
    expect(activities.map((entry) => entry.action)).toContain(REVIEW_REWORK_ACCEPTANCE_ACTION);
    // The idempotence marker: a second pass sees the handoff comment and noops.
    store.comments = [
      ...verdictComment(),
      { id: "c-2", body: "Code merged; acceptance pending by the review-return loop: PR acme/repo#484 is merged.", createdAt: new Date("2026-10-05T09:01:00Z") },
    ];
    const second = await sweep.sweep(new Date("2026-10-05T09:02:00Z"), { force: true });
    expect(second.awaitedAcceptance).toBe(0);
    expect(second.closed).toBe(0);
    expect(store.awaited).toHaveLength(1);
    expect(store.closed).toHaveLength(0);
  });

  it("OPE-12260: a description naming a live/operator acceptance step also holds the close", async () => {
    const store = new FakeStore();
    store.rows = [
      candidateRow(reviewTask({
        status: "in_review",
        description: "Критерий приёмки: живая приёмка на бою, шаг выполняет оператор.",
      })),
    ];
    store.comments = verdictComment();
    const { sweep } = build({
      store,
      snapshot: { state: "merged", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-05T09:00:00Z"), { force: true });

    expect(result.closed).toBe(0);
    expect(result.awaitedAcceptance).toBe(1);
    expect(store.closed).toHaveLength(0);
    expect(store.awaited).toHaveLength(1);
  });

  it("OPE-12260: an ordinary merged review still closes with no acceptance markers", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask({ status: "in_review" }))];
    store.comments = verdictComment();
    const { sweep } = build({
      store,
      snapshot: { state: "merged", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-05T09:00:00Z"), { force: true });

    expect(result.closed).toBe(1);
    expect(result.awaitedAcceptance).toBe(0);
    expect(store.closed).toHaveLength(1);
    expect(store.awaited).toHaveLength(0);
  });

  it("a settled rework with a newer RETURN reopens the same task", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask({ status: "todo" }))];
    store.comments = [
      ...verdictComment(),
      { id: "c-2", body: "VERDICT #484: RETURN (head " + HEAD_NEW + ")", createdAt: new Date("2026-10-05T08:30:00Z") },
    ];
    store.child = {
      id: "rework-1",
      identifier: "OPE-4502",
      status: "done",
      assigneeAgentId: "author-agent",
      prKey: "acme/repo#484",
      baselineHeadSha: HEAD_OLD,
    };
    const { sweep } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_NEW, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-05T09:00:00Z"), { force: true });

    expect(result.reworkReopened).toBe(1);
    expect(store.created).toHaveLength(0);
    expect(store.reopened[0]!.originFingerprint).toBe(`acme/repo#484@${HEAD_NEW}`);
  });

  it("settings off: the pass does nothing at all", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask())];
    store.comments = verdictComment();
    const { sweep } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
      settings: { enabled: false },
    });

    const result = await sweep.sweep(new Date("2026-10-04T17:00:00Z"), { force: true });
    expect(result.scanned).toBe(0);
    expect(store.created).toHaveLength(0);
  });

  it("maintenance skips the whole pass", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask())];
    store.comments = verdictComment();
    const { sweep } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
      maintenance: true,
    });
    const result = await sweep.sweep(new Date("2026-10-04T17:00:00Z"), { force: true });
    expect(result.skippedPass).toBe(true);
    expect(store.created).toHaveLength(0);
  });

  it("the interval gate keeps the second tick quiet", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask())];
    store.comments = verdictComment();
    const { sweep } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
      intervalMs: 60_000,
    });
    await sweep.sweep(new Date("2026-10-04T17:00:00Z"));
    store.created = [];
    const second = await sweep.sweep(new Date("2026-10-04T17:00:30Z"));
    expect(second.skippedPass).toBe(true);
    expect(store.created).toHaveLength(0);
  });

  it("an unresolved PR moves nothing — a GitHub outage invents no verdict", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask())];
    store.comments = verdictComment();
    const { sweep } = build({ store, snapshot: null });
    const result = await sweep.sweep(new Date("2026-10-04T17:00:00Z"), { force: true });
    expect(result.reworkCreated).toBe(0);
    expect(result.blocked).toBe(0);
    expect(store.created).toHaveLength(0);
  });

  it("a work product without a repo does not fail the pass — the valid PR is still handled", async () => {
    const store = new FakeStore();
    // A legacy work product whose coordinates could not be read (no repo in
    // the metadata, no parseable URL): the spread lands a repo-less entry.
    const broken = { ...(null as unknown as object), status: "active" } as unknown as ReworkCandidateRow["products"][number];
    const row = candidateRow(reviewTask());
    row.products = [broken, ...row.products];
    store.rows = [row];
    store.comments = verdictComment();
    const { sweep } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-04T17:00:00Z"), { force: true });

    expect(result.failed).toBe(0);
    expect(result.reworkCreated).toBe(1);
    expect(store.created).toHaveLength(1);
    expect(store.created[0]!.originFingerprint).toBe(`acme/repo#484@${HEAD_OLD}`);
  });

  it("a work product with only a URL restores the repo from the URL", async () => {
    const store = new FakeStore();
    const urlOnly = { repo: null, number: 484, url: PR_URL, status: "active" } as unknown as ReworkCandidateRow["products"][number];
    const row = candidateRow(reviewTask());
    row.products = [urlOnly];
    row.textParts = ["no coordinates in text", ""];
    store.rows = [row];
    store.comments = verdictComment();
    const { sweep } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
    });

    const result = await sweep.sweep(new Date("2026-10-04T17:00:00Z"), { force: true });

    expect(result.failed).toBe(0);
    expect(result.reworkCreated).toBe(1);
    expect(store.created[0]!.originFingerprint).toBe(`acme/repo#484@${HEAD_OLD}`);
  });

  // myrmidon(OPE-12397): the sweep's GitHub budget. Every candidate pass used
  // to re-read every linked PR — the acceptance is one read per PR per pass,
  // no reads for rows that cannot move, and the pass itself paced by the
  // stored setting (the env override wins only as the deployment fallback).
  describe("one GitHub read per pull request per pass (OPE-12397)", () => {
    const PASS_AT = new Date("2026-10-04T17:00:00Z");
    const snapshot: ReviewReworkPrSnapshot = { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null };

    it("reads one PR once even when the task names it twice", async () => {
      const store = new FakeStore();
      const row = candidateRow(reviewTask());
      // The URL in the text, the full-repo reference and the work product all
      // point at the same pull request; the old path resolved it per match.
      row.textParts = [`Review https://github.com/acme/repo/pull/484 (acme/repo#484)`, ""];
      store.rows = [row];
      store.comments = verdictComment();
      const { sweep, getResolveCalls } = build({ store, snapshot });

      const result = await sweep.sweep(PASS_AT, { force: true });

      expect(getResolveCalls()).toBe(1);
      expect(result.reworkCreated).toBe(1);
    });

    it("reads a shared PR once when two review tasks link it and evaluates both tasks", async () => {
      const store = new FakeStore();
      const first = candidateRow(reviewTask());
      const second = candidateRow(reviewTask({ id: "review-2", identifier: "OPE-4418" }));
      store.rows = [first, second];
      store.comments = verdictComment();
      const { sweep, getResolveCalls } = build({ store, snapshot });

      const result = await sweep.sweep(PASS_AT, { force: true });

      // One read for acme/repo#484; the second task rides on the same pass snapshot.
      expect(getResolveCalls()).toBe(1);
      // Both tasks link the same PR with RETURN verdict; both should have rework created and be blocked
      expect(result.reworkCreated).toBe(2);
      expect(result.blocked).toBe(2);
      expect(store.created).toHaveLength(2);
      expect(store.blocked).toHaveLength(2);
    });

    it("skips a candidate with no rework child, no verdict and no live product", async () => {
      const store = new FakeStore();
      const row = candidateRow(reviewTask());
      row.childPresent = false;
      row.verdictPresent = false;
      row.products = []; // nothing live either
      store.rows = [row];
      store.comments = [];
      const { sweep, getResolveCalls } = build({ store, snapshot });

      const result = await sweep.sweep(PASS_AT, { force: true });

      // The read would have been a `no_linked_pr` no-op; the guard drops the
      // row before the comments and GitHub reads.
      expect(getResolveCalls()).toBe(0);
      expect(result.scanned).toBe(1);
      expect(store.created).toHaveLength(0);
    });

    it("short-circuits and makes zero GitHub calls when rate limited", async () => {
      const store = new FakeStore();
      const row = candidateRow(reviewTask());
      store.rows = [row];
      store.comments = verdictComment();
      const { sweep, getResolveCalls } = build({ store, snapshot });

      // When rate-limited, isGitHubRateLimited() is true
      setGitHubRateLimitForTests(Math.floor(Date.now() / 1000) + 3600, 0);

      const result = await sweep.sweep(PASS_AT, { force: true });

      expect(result.skippedPass).toBe(true);
      expect(getResolveCalls()).toBe(0);
      expect(store.created).toHaveLength(0);
    });

    it("skips a candidate whose only product is terminal", async () => {
      const store = new FakeStore();
      const row = candidateRow(reviewTask());
      row.childPresent = false;
      row.verdictPresent = false;
      row.products = [{ repo: "acme/repo", number: 484, url: PR_URL, status: "merged" }];
      store.rows = [row];
      store.comments = [];
      const { sweep, getResolveCalls } = build({ store, snapshot });

      const result = await sweep.sweep(PASS_AT, { force: true });

      expect(getResolveCalls()).toBe(0);
      expect(store.created).toHaveLength(0);
    });

    it("keeps a row whose flags are unknown (hand-built) — the guard never skips the old path", async () => {
      const store = new FakeStore();
      const row = candidateRow(reviewTask());
      row.childPresent = undefined;
      row.verdictPresent = undefined;
      row.products = [];
      store.rows = [row];
      store.comments = verdictComment();
      const { sweep, getResolveCalls } = build({ store, snapshot });

      const result = await sweep.sweep(PASS_AT, { force: true });

      expect(getResolveCalls()).toBe(1);
      expect(result.reworkCreated).toBe(1);
    });
  });

  describe("the sweep interval is a setting with an env override (OPE-12397)", () => {
    const snapshot: ReviewReworkPrSnapshot = {
      state: "open",
      headSha: HEAD_OLD,
      reviewDecision: null,
      updatedAt: null,
    };

    function seeded(store: FakeStore) {
      store.rows = [candidateRow(reviewTask())];
      store.comments = verdictComment();
    }

    it("paces by the stored setting (300 s default) without intervalMs", async () => {
      const store = new FakeStore();
      seeded(store);
      const { sweep } = build({ store, snapshot, settings: { sweepIntervalSec: 300 } });
      await sweep.sweep(new Date("2026-10-04T17:00:00Z"));
      const second = await sweep.sweep(new Date("2026-10-04T17:04:59Z"));
      expect(second.skippedPass).toBe(true);
      const third = await sweep.sweep(new Date("2026-10-04T17:05:00Z"));
      expect(third.skippedPass).toBe(false);
    });

    it("the env override beats the stored setting and the input range holds", async () => {
      const store = new FakeStore();
      seeded(store);
      const { sweep } = build({
        store,
        snapshot,
        settings: { sweepIntervalSec: 3600 },
        env: { MYRMIDON_REVIEW_REWORK_SWEEP_INTERVAL_SEC: "120" },
      });
      await sweep.sweep(new Date("2026-10-04T17:00:00Z"));
      // The stored 3600 s would hold the pass; the env 120 s does not.
      const second = await sweep.sweep(new Date("2026-10-04T17:02:00Z"));
      expect(second.skippedPass).toBe(false);
    });

    it("an out-of-range or malformed env value falls back to the stored setting", async () => {
      const store = new FakeStore();
      seeded(store);
      const { sweep } = build({
        store,
        snapshot,
        settings: { sweepIntervalSec: 300 },
        env: { MYRMIDON_REVIEW_REWORK_SWEEP_INTERVAL_SEC: "banana" },
      });
      await sweep.sweep(new Date("2026-10-04T17:00:00Z"));
      const second = await sweep.sweep(new Date("2026-10-04T17:04:00Z"));
      expect(second.skippedPass).toBe(true); // still inside the stored 300 s
      const third = await sweep.sweep(new Date("2026-10-04T17:05:00Z"));
      expect(third.skippedPass).toBe(false);
    });

    it("an explicit intervalMs (tests, callers pinning the pace) wins over everything", async () => {
      const store = new FakeStore();
      seeded(store);
      const { sweep } = build({
        store,
        snapshot,
        settings: { sweepIntervalSec: 3600 },
        intervalMs: 60_000,
        env: { MYRMIDON_REVIEW_REWORK_SWEEP_INTERVAL_SEC: "3600" },
      });
      await sweep.sweep(new Date("2026-10-04T17:00:00Z"));
      const second = await sweep.sweep(new Date("2026-10-04T17:01:00Z"));
      expect(second.skippedPass).toBe(false);
    });
  });

  it("only the leader sweeps; a secondary process keeps its timer but reads nothing", async () => {
    const store = new FakeStore();
    store.rows = [candidateRow(reviewTask())];
    store.comments = verdictComment();
    const { sweep, getResolveCalls } = build({
      store,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
      isLeader: () => false,
    });

    const result = await sweep.sweep(new Date("2026-10-04T17:00:00Z"));

    expect(result.skippedPass).toBe(true);
    expect(getResolveCalls()).toBe(0);
    expect(store.created).toHaveLength(0);

    // The leader changeover: the next tick runs the pass immediately.
    const store2 = new FakeStore();
    store2.rows = [candidateRow(reviewTask())];
    store2.comments = verdictComment();
    let leading = false;
    const { sweep: sweep2, getResolveCalls: getCalls2 } = build({
      store: store2,
      snapshot: { state: "open", headSha: HEAD_OLD, reviewDecision: null, updatedAt: null },
      isLeader: () => leading,
    });
    await sweep2.sweep(new Date("2026-10-04T17:00:00Z"));
    leading = true;
    const second = await sweep2.sweep(new Date("2026-10-04T17:00:10Z"));
    expect(second.skippedPass).toBe(false);
    expect(getCalls2()).toBe(1);
  });
});

describe("review rework PR coordinate extraction", () => {
  it("reads the full-repo form and the URL form", () => {
    const coords = extractPrCoordinates(
      ["Review itkadr-git/myrmidon#484 — see https://github.com/acme/repo/pull/513"],
      [],
    );
    const keys = coords.map((entry) => `${entry.repo}#${entry.number}`).sort();
    expect(keys).toEqual(["acme/repo#513", "itkadr-git/myrmidon#484"]);
  });

  it("pairs a bare number with a single repo token in the text", () => {
    const coords = extractPrCoordinates(["ВЕРДИКТ по itkadr-git/myrmidon: RETURN, PR #484"], []);
    expect(coords).toEqual([{ repo: "itkadr-git/myrmidon", number: 484 }]);
  });

  it("refuses to pair a bare number when two repos appear", () => {
    const coords = extractPrCoordinates(["acme/one and acme/two, PR #484"], []);
    expect(coords).toEqual([]);
  });

  it("keeps the work-product coordinates", () => {
    const coords = extractPrCoordinates(["no text refs"], [{ repo: "acme/repo", number: 9 }]);
    expect(coords).toEqual([{ repo: "acme/repo", number: 9 }]);
  });

  it("skips a known entry with no repo instead of throwing", () => {
    const coords = extractPrCoordinates(["no text refs"], [{ number: 484 }]);
    expect(coords).toEqual([]);
  });

  it("restores the repo from the entry's pull-request URL", () => {
    const coords = extractPrCoordinates(
      ["no text refs"],
      [{ number: 484, url: "https://github.com/acme/repo/pull/484" }],
    );
    expect(coords).toEqual([{ repo: "acme/repo", number: 484 }]);
  });

  it("skips a known entry whose URL is not a pull-request link", () => {
    const coords = extractPrCoordinates(
      ["no text refs"],
      [{ repo: null, number: 484, url: "https://example.com/not-a-pr" }],
    );
    expect(coords).toEqual([]);
  });
});
