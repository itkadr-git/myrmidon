// myrmidon(REVIEW-ROUTING): the sweep against a fake store — assignment by
// least load, the attention signal when nobody is available, the overdue
// reassignment, settings applied on the next pass, and idempotency. The PR
// lane rides here against a fake store and a fake head resolver.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS,
  REVIEW_ROUTING_ASSIGNED_ACTION,
  REVIEW_ROUTING_PR_TASK_CREATED_ACTION,
  REVIEW_ROUTING_REASSIGNED_ACTION,
  REVIEW_ROUTING_WAKE_ACTION,
  REVIEW_ROUTING_STEWARD_TASK_CREATED_ACTION,
  normalizeReviewRoutingSettings,
  type ReviewRoutingSettings,
} from "@myrmidon/shared";
import { readReviewRoutingSignals, resetReviewRoutingSignals } from "./attention.js";
import type { CreatePrRoutingTaskInput, InReviewIssueRow, PrCandidateRow, PrRoutingKind, ReviewRoutingStore, RoutingHistory } from "./store.js";
import type { PrRoutedTask } from "./pr-policy.js";
import type { RoutingIssue } from "./policy.js";
import { createReviewRoutingSweep, REVIEW_WAKE_MAX_BACKOFF_MS, REVIEW_WAKE_RETRY_BACKOFF_MS } from "./sweep.js";
import type { PullRequestHeadResolver } from "./github.js";
import type { PullRequestHeadState } from "./pr-policy.js";

const COMPANY = "company-1";
const AUTHOR = "aaaaaaaa-0000-4000-8000-000000000001";
const ASSIGNEE = "aaaaaaaa-0000-4000-8000-000000000002";
const REV_A = "bbbbbbbb-0000-4000-8000-000000000001";
const REV_B = "bbbbbbbb-0000-4000-8000-000000000002";
const STEWARD = "cccccccc-0000-4000-8000-000000000001";
const NOW = new Date("2026-03-10T12:00:00Z");

function row(id: string, overrides: Partial<InReviewIssueRow> = {}): InReviewIssueRow {
  return {
    id,
    companyId: COMPANY,
    identifier: `T-${id}`,
    title: `Task ${id}`,
    status: "in_review",
    createdAt: new Date(NOW.getTime() - 6 * 60 * 60_000),
    updatedAt: new Date(NOW.getTime() - 6 * 60 * 60_000),
    assigneeAgentId: ASSIGNEE,
    assigneeUserId: null,
    createdByAgentId: AUTHOR,
    createdByUserId: null,
    executionPolicy: null,
    executionState: null,
    ...overrides,
  };
}

interface Fixture {
  rows: Map<string, InReviewIssueRow>;
  reviewers: Array<{ id: string; role: string }>;
  load: Map<string, number>;
  history: Map<string, RoutingHistory>;
  activities: Array<{ action: string; issueId: string; details: Record<string, unknown> }>;
  wakeStates?: Map<string, { activeRun: boolean; pendingWake: boolean; lastWakeAt: Date | null; attempts: number }>;
}

function makeStore(fx: Fixture) {
  return {
    listActiveCompanyIds: async () => [COMPANY],
    listInReviewIssues: async () => [...fx.rows.values()],
    listReviewerAgents: async (_company: string, roles: readonly string[]) => fx.reviewers.filter((agent) => roles.includes(agent.role)),
    loadByAgent: async () => new Map(fx.load),
    routingHistory: async (_company: string, ids: readonly string[]) => new Map([...fx.history].filter(([id]) => ids.includes(id))),
    reviewWakeState: async ({ issueId }: { companyId: string; issueId: string; reviewerAgentId: string; stageId: string }) => {
      return fx.wakeStates?.get(issueId) ?? { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 };
    },
    recordReviewWake: async ({ issueId, at, attempt }: { companyId: string; issueId: string; reviewerAgentId: string; stageId: string; at: Date; attempt: number }) => {
      const existing = fx.wakeStates?.get(issueId);
      const state = existing ?? { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 };
      fx.wakeStates?.set(issueId, { ...state, lastWakeAt: at, attempts: attempt });
    },
    applyPatch: async ({ issueId, guard, build }: { issueId: string; companyId: string; guard: (fresh: RoutingIssue) => boolean; build: (fresh: RoutingIssue) => Record<string, unknown> | null }) => {
      const current = fx.rows.get(issueId);
      if (!current || !guard(current)) return null;
      const patch = build(current);
      if (!patch) return null;
      const next = { ...current, ...(patch as Partial<InReviewIssueRow>) };
      fx.rows.set(issueId, next as InReviewIssueRow);
      return { executionState: (next.executionState as Record<string, unknown>) ?? null };
    },
  } as unknown as ReviewRoutingStore;
}

// A settings override as written in a settings screen: every key, including
// nested prWatch keys, may be absent — normalization fills the defaults.
type SettingsOverride = {
  enabled?: boolean;
  reviewerRoles?: string[];
  maxLoadPerReviewer?: number;
  reassignAfterHours?: number;
  prWatch?: Partial<ReviewRoutingSettings["prWatch"]> & {
    steward?: Partial<ReviewRoutingSettings["prWatch"]["steward"]>;
  };
};

function setup(settings: SettingsOverride = {}, fx?: Partial<Fixture>) {
  const fixture: Fixture = {
    rows: new Map(),
    reviewers: [
      { id: REV_A, role: "reviewer" },
      { id: REV_B, role: "reviewer" },
    ],
    load: new Map(),
    history: new Map(),
    activities: [],
    wakeStates: new Map(),
    ...fx,
  };
  let current = normalizeReviewRoutingSettings(settings);
  const activities: Array<{ action: string; issueId: string; details: Record<string, unknown> }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const wakes: Array<{ agentId: string; issueId: string; executionStage: Record<string, unknown>; retryAttempt?: number }> = [];
  const wakeReviewer = vi.fn(async (agentId: string, wake: { issueId: string; executionStage: Record<string, unknown>; retryAttempt?: number }) => {
    wakes.push({ agentId, issueId: wake.issueId, executionStage: wake.executionStage, retryAttempt: wake.retryAttempt });
  });
  const sweep = createReviewRoutingSweep({
    store: makeStore(fixture),
    readSettings: async () => current,
    addComment: async (issueId, body) => {
      comments.push({ issueId, body });
    },
    wakeReviewer,
    logActivity: async (entry) => {
      activities.push({ action: entry.action, issueId: entry.issueId, details: entry.details });
      if (entry.action === REVIEW_ROUTING_WAKE_ACTION && existingWake) {
        fixture.wakeStates?.set(entry.issueId, {
          ...existingWake,
          lastWakeAt: new Date(String(entry.createdAt)),
          attempts: Number(entry.details.attempt ?? existingWake.attempts),
        });
      }
      if (entry.action === REVIEW_ROUTING_ASSIGNED_ACTION) {
        const previous = fixture.history.get(entry.issueId);
        fixture.history.set(entry.issueId, {
          lastAt: NOW,
          reviewerAgentIds: [...(previous?.reviewerAgentIds ?? []), String(entry.details.reviewerAgentId)],
        });
      }
      const existingWake = fixture.wakeStates?.get(entry.issueId);
      if (entry.action === REVIEW_ROUTING_WAKE_ACTION && existingWake) {
        fixture.wakeStates?.set(entry.issueId, {
          ...existingWake,
          lastWakeAt: NOW,
          attempts: Number(entry.details.attempt ?? entry.details.retryAttempt ?? existingWake.attempts),
        });
      }
    },
    log: { info: vi.fn(), warn: vi.fn() },
  });
  return {
    fixture,
    sweep,
    activities,
    comments,
    wakes,
    wakeReviewer,
    setSettings: (next: SettingsOverride) => {
      current = normalizeReviewRoutingSettings(next);
    },
  };
}

beforeEach(() => resetReviewRoutingSignals());

describe("review wake liveness", () => {
  function pending(id: string, reviewerId: string, overrides: Partial<InReviewIssueRow> = {}) {
    const state = {
      status: "pending",
      currentStageId: `stage-${id}`,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerId },
      lastDecisionOutcome: null,
      humanReviewPending: false,
    };
    const policy = { mode: "normal", stages: [{ id: `stage-${id}`, type: "review", participants: [{ type: "agent", agentId: reviewerId }] }] };
    return row(id, { assigneeAgentId: reviewerId, executionState: state, executionPolicy: policy, ...overrides });
  }

  it("wakes one stale pending review per reviewer when no run or wake exists", async () => {
    const t = setup({}, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 }],
      ["2", { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 }],
    ]) });
    t.fixture.rows.set("1", pending("1", REV_A));
    t.fixture.rows.set("2", pending("2", REV_A));
    t.fixture.rows.set("3", pending("3", REV_B));
    t.fixture.wakeStates!.set("1", { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 });
    t.fixture.wakeStates!.set("2", { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 });
    t.fixture.wakeStates!.set("3", { activeRun: false, pendingWake: true, lastWakeAt: null, attempts: 0 });
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(1);
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]).toMatchObject({ agentId: REV_A, issueId: "1", retryAttempt: 1 });
    expect(t.activities).toEqual([
      expect.objectContaining({ action: REVIEW_ROUTING_WAKE_ACTION, issueId: "1", details: expect.objectContaining({ reviewerAgentId: REV_A, stageId: "stage-1", attempt: 1 }) }),
    ]);
    expect(t.fixture.history.get("1")).toBeUndefined();
  });

  it("records one wake activity event for a successful retry", async () => {
    const t = setup({}, { wakeStates: new Map() });
    t.fixture.rows.set("1", pending("1", REV_A));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(1);
    expect(t.fixture.wakeStates!.get("1")).toEqual({ activeRun: false, pendingWake: false, lastWakeAt: NOW, attempts: 1 });
    expect(t.activities).toEqual([
      expect.objectContaining({ action: REVIEW_ROUTING_WAKE_ACTION, issueId: "1", details: expect.objectContaining({ reviewerAgentId: REV_A, stageId: "stage-1", attempt: 1 }) }),
    ]);
  });
  it("records a wake before dispatch; dispatch failures still respect persisted backoff", async () => {
    const t = setup({}, { wakeStates: new Map() });
    t.fixture.rows.set("1", pending("1", REV_A));
    t.wakeReviewer.mockRejectedValueOnce(new Error("dispatch unavailable"));
    const first = await t.sweep.sweep(NOW, { force: true });
    expect(first.failed).toBe(1);
    expect(t.fixture.wakeStates!.get("1")).toEqual({ activeRun: false, pendingWake: false, lastWakeAt: NOW, attempts: 1 });
    const second = await t.sweep.sweep(new Date(NOW.getTime() + 60_000), { force: true });
    expect(second.woken).toBe(0);
    expect(t.wakeReviewer).toHaveBeenCalledTimes(1);
  });

  it("measures the 30-minute stale threshold from last update, not issue creation", async () => {
    const t = setup({}, { wakeStates: new Map() });
    t.fixture.rows.set("1", pending("1", REV_A, { updatedAt: new Date(NOW.getTime() - 10 * 60_000) }));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(0);
    expect(t.wakes).toHaveLength(0);
  });

  it("recovers stale reviews regardless of assignment load, while respecting active runs and pending wakes", async () => {
    const t = setup({ maxLoadPerReviewer: 1 }, { wakeStates: new Map() });
    t.fixture.load.set(REV_A, 12);
    t.fixture.wakeStates!.set("1", { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 });
    t.fixture.wakeStates!.set("2", { activeRun: true, pendingWake: false, lastWakeAt: null, attempts: 0 });
    t.fixture.wakeStates!.set("3", { activeRun: false, pendingWake: true, lastWakeAt: null, attempts: 0 });
    t.fixture.rows.set("1", pending("1", REV_A));
    t.fixture.rows.set("2", pending("2", REV_A));
    t.fixture.rows.set("3", pending("3", REV_A));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(1);
    expect(t.wakes.map(({ issueId }) => issueId)).toEqual(["1"]);
  });

  it("caps exponential retry backoff at 60 minutes", async () => {
    const t = setup({}, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 59 * 60_000), attempts: 12 }],
    ]) });
    expect(REVIEW_WAKE_MAX_BACKOFF_MS).toBe(60 * 60_000);
    expect(Math.min(REVIEW_WAKE_MAX_BACKOFF_MS, REVIEW_WAKE_RETRY_BACKOFF_MS * 2 ** 12)).toBe(60 * 60_000);
    expect(Math.min(REVIEW_WAKE_MAX_BACKOFF_MS, REVIEW_WAKE_RETRY_BACKOFF_MS * 2 ** 11)).toBe(60 * 60_000);
    t.fixture.rows.set("1", pending("1", REV_A));
    expect((await t.sweep.sweep(NOW, { force: true })).woken).toBe(0);
    const retryAt = new Date(NOW.getTime() + 60_000);
    expect((await t.sweep.sweep(retryAt, { force: true })).woken).toBe(1);
    expect(t.wakes[0]?.retryAttempt).toBe(13);
  });
  it("does not wake a review before 30 minutes or inside retry backoff", async () => {
    const t = setup({ maxLoadPerReviewer: 2 }, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 5 * 60_000), attempts: 1 }],
      ["2", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 2 * 60_000), attempts: 1 }],
    ]) });
    t.fixture.rows.set("1", pending("1", REV_A, { updatedAt: new Date(NOW.getTime() - 20 * 60_000) }));
    t.fixture.rows.set("2", pending("2", REV_B));
    t.fixture.wakeStates!.set("1", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 5 * 60_000), attempts: 1 });
    t.fixture.wakeStates!.set("2", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 2 * 60_000), attempts: 1 });
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(0);
    expect(t.wakes).toHaveLength(0);
  });
});

describe("assignment", () => {
  it("assigns the least loaded reviewer, comments, logs and wakes it", async () => {
    const t = setup({}, { load: new Map([[REV_A, 3], [REV_B, 1]]) });
    t.fixture.rows.set("1", row("1"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ assigned: 1, signaled: 0, failed: 0 });
    const updated = t.fixture.rows.get("1")!;
    expect(updated.assigneeAgentId).toBe(REV_B);
    expect((updated.executionState as Record<string, any>).currentParticipant.agentId).toBe(REV_B);
    expect(t.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: REVIEW_ROUTING_ASSIGNED_ACTION, issueId: "1" }),
    ]));
    expect(t.comments).toHaveLength(1);
    expect(t.wakes).toEqual([expect.objectContaining({ agentId: REV_B, issueId: "1" })]);
    expect(t.wakes[0]?.executionStage).toMatchObject({ wakeRole: "reviewer" });
    expect(readReviewRoutingSignals(COMPANY)).toEqual([]);
  });

  it("spreads a batch over reviewers by counting what it just assigned", async () => {
    const t = setup();
    for (const id of ["1", "2", "3", "4"]) t.fixture.rows.set(id, row(id));
    await t.sweep.sweep(NOW, { force: true });
    const reviewers = ["1", "2", "3", "4"].map((id) => t.fixture.rows.get(id)!.assigneeAgentId);
    expect(reviewers.filter((id) => id === REV_A)).toHaveLength(2);
    expect(reviewers.filter((id) => id === REV_B)).toHaveLength(2);
  });

  it("never picks the author or the assignee, even when they are the least loaded reviewers", async () => {
    const t = setup(
      {},
      {
        reviewers: [
          { id: AUTHOR, role: "reviewer" },
          { id: ASSIGNEE, role: "reviewer" },
          { id: REV_A, role: "reviewer" },
        ],
        load: new Map([[REV_A, 4]]),
      },
    );
    t.fixture.rows.set("1", row("1"));
    await t.sweep.sweep(NOW, { force: true });
    expect(t.fixture.rows.get("1")!.assigneeAgentId).toBe(REV_A);
  });

  it("only considers the configured reviewer roles", async () => {
    const t = setup(
      { reviewerRoles: ["qa"] },
      { reviewers: [{ id: REV_A, role: "reviewer" }, { id: REV_B, role: "qa" }] },
    );
    t.fixture.rows.set("1", row("1"));
    await t.sweep.sweep(NOW, { force: true });
    expect(t.fixture.rows.get("1")!.assigneeAgentId).toBe(REV_B);
  });

  it("is idempotent: a second pass over an assigned task does nothing", async () => {
    const t = setup();
    t.fixture.rows.set("1", row("1"));
    await t.sweep.sweep(NOW, { force: true });
    const second = await t.sweep.sweep(NOW, { force: true });
    expect(second).toMatchObject({ assigned: 0, reassigned: 0, signaled: 0 });
    expect(t.activities).toHaveLength(2);
    expect(t.activities.filter((entry) => entry.action === REVIEW_ROUTING_ASSIGNED_ACTION)).toHaveLength(1);
  });

  it("does not undo the assignment when the wake fails", async () => {
    const t = setup();
    t.wakeReviewer.mockRejectedValueOnce(new Error("agent over budget"));
    t.fixture.rows.set("1", row("1"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.assigned).toBe(1);
    expect(t.activities.map((entry) => entry.action)).toEqual([
      REVIEW_ROUTING_ASSIGNED_ACTION,
    ]);
  });

  it("stands down when a racing writer already gave the task a reviewer", async () => {
    const t = setup();
    t.fixture.rows.set("1", row("1"));
    const store = makeStore(t.fixture);
    const raced = createReviewRoutingSweep({
      store: {
        ...store,
        applyPatch: async (input) => {
          // A human assigned a reviewer between the read and the lock.
          t.fixture.rows.set("1", row("1", { executionPolicy: { stages: [{ id: "s", type: "review", participants: [{ type: "user", userId: "u" }] }] } }));
          return store.applyPatch(input);
        },
      },
      readSettings: async () => normalizeReviewRoutingSettings({}),
      addComment: async () => undefined,
      wakeReviewer: async () => undefined,
      logActivity: async () => undefined,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    const result = await raced.sweep(NOW, { force: true });
    expect(result).toMatchObject({ assigned: 0, signaled: 0, failed: 0 });
  });
});

describe("no reviewer available", () => {
  it("raises a no_reviewer signal instead of staying silent", async () => {
    const t = setup({}, { reviewers: [] });
    t.fixture.rows.set("1", row("1"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ assigned: 0, signaled: 1 });
    expect(readReviewRoutingSignals(COMPANY)).toEqual([
      expect.objectContaining({ kind: "no_reviewer", issueId: "1", identifier: "T-1" }),
    ]);
    expect(t.comments).toHaveLength(0);
  });

  it("raises the signal when every reviewer is at the load ceiling", async () => {
    const t = setup({ maxLoadPerReviewer: 2 }, { load: new Map([[REV_A, 2], [REV_B, 5]]) });
    t.fixture.rows.set("1", row("1"));
    await t.sweep.sweep(NOW, { force: true });
    expect(readReviewRoutingSignals(COMPANY)[0]?.kind).toBe("no_reviewer");
  });

  it("clears the signal once a reviewer appears", async () => {
    const t = setup({}, { reviewers: [] });
    t.fixture.rows.set("1", row("1"));
    await t.sweep.sweep(NOW, { force: true });
    expect(readReviewRoutingSignals(COMPANY)).toHaveLength(1);
    t.fixture.reviewers.push({ id: REV_A, role: "reviewer" });
    await t.sweep.sweep(NOW, { force: true });
    expect(readReviewRoutingSignals(COMPANY)).toEqual([]);
    expect(t.fixture.rows.get("1")!.assigneeAgentId).toBe(REV_A);
  });

  it("keeps the original since while the condition holds", async () => {
    const t = setup({}, { reviewers: [] });
    t.fixture.rows.set("1", row("1"));
    await t.sweep.sweep(NOW, { force: true });
    await t.sweep.sweep(new Date(NOW.getTime() + 600_000), { force: true });
    expect(readReviewRoutingSignals(COMPANY)[0]?.since).toBe(NOW.toISOString());
  });
});

describe("overdue review", () => {
  async function routedPending(t: ReturnType<typeof setup>, at: Date) {
    t.fixture.rows.set("1", row("1"));
    await t.sweep.sweep(at, { force: true });
    return t.fixture.rows.get("1")!.assigneeAgentId!;
  }

  it("signals and reassigns to another reviewer after the configured hours", async () => {
    const t = setup({ reassignAfterHours: 24 });
    const first = await routedPending(t, NOW);
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    const result = await t.sweep.sweep(later, { force: true });
    expect(result).toMatchObject({ reassigned: 1 });
    const second = t.fixture.rows.get("1")!.assigneeAgentId!;
    expect(second).not.toBe(first);
    expect([REV_A, REV_B]).toContain(second);
    expect(t.activities.map((entry) => entry.action).filter((action) => action !== REVIEW_ROUTING_WAKE_ACTION)).toEqual([
      REVIEW_ROUTING_ASSIGNED_ACTION,
      REVIEW_ROUTING_REASSIGNED_ACTION,
    ]);
    // The card of a completed reassignment stays on the desk.
    expect(readReviewRoutingSignals(COMPANY)).toEqual([
      expect.objectContaining({ kind: "review_overdue", issueId: "1" }),
    ]);
    // The original assignee stays the return assignee.
    expect(((t.fixture.rows.get("1")!.executionState) as Record<string, any>).returnAssignee.agentId).toBe(ASSIGNEE);
  });

  it("does nothing before the threshold", async () => {
    const t = setup({ reassignAfterHours: 24 });
    await routedPending(t, NOW);
    const result = await t.sweep.sweep(new Date(NOW.getTime() + 23 * 3_600_000), { force: true });
    expect(result).toMatchObject({ reassigned: 0, signaled: 0 });
  });

  it("never reassigns when the hours are 0", async () => {
    const t = setup({ reassignAfterHours: 0 });
    await routedPending(t, NOW);
    const result = await t.sweep.sweep(new Date(NOW.getTime() + 1000 * 3_600_000), { force: true });
    expect(result).toMatchObject({ reassigned: 0, signaled: 0 });
  });

  it("signals but keeps the reviewer when nobody else is eligible", async () => {
    const t = setup({}, { reviewers: [{ id: REV_A, role: "reviewer" }] });
    await routedPending(t, NOW);
    const result = await t.sweep.sweep(new Date(NOW.getTime() + 48 * 3_600_000), { force: true });
    expect(result).toMatchObject({ reassigned: 0, signaled: 1 });
    expect(t.fixture.rows.get("1")!.assigneeAgentId).toBe(REV_A);
    expect(readReviewRoutingSignals(COMPANY)[0]).toMatchObject({ kind: "review_overdue", hoursInReview: 48 });
  });

  it("does not hand the task back to a reviewer that already had it", async () => {
    const t = setup();
    await routedPending(t, NOW);
    await t.sweep.sweep(new Date(NOW.getTime() + 25 * 3_600_000), { force: true });
    const third = await t.sweep.sweep(new Date(NOW.getTime() + 50 * 3_600_000), { force: true });
    // Both reviewers have had it: only the signal remains.
    expect(third.reassigned).toBe(0);
    expect(t.activities.filter((entry) => entry.action === REVIEW_ROUTING_REASSIGNED_ACTION)).toHaveLength(1);
  });

  it("leaves a human-set review (no routing history) alone", async () => {
    const t = setup();
    const policy = { stages: [{ id: "s", type: "review", participants: [{ type: "agent", agentId: REV_A }] }] };
    const state = {
      status: "pending",
      currentStageId: "s",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: REV_A },
      returnAssignee: { type: "agent", agentId: ASSIGNEE },
    };
    t.fixture.rows.set("1", row("1", { assigneeAgentId: REV_A, executionPolicy: policy, executionState: state }));
    const result = await t.sweep.sweep(new Date(NOW.getTime() + 500 * 3_600_000), { force: true });
    expect(result).toMatchObject({ reassigned: 0, signaled: 0 });
  });
});

describe("PR lane (fake store + fake resolver)", () => {
  interface PrFixture {
    candidates: PrCandidateRow[];
    knownRepos: string[];
    routed: PrRoutedTask[];
    openReviewLoad: Map<string, number>;
    openMergeLoad: Map<string, number>;
    created: Array<{ title: string; kind: string; assigneeAgentId: string; headSha: string }>;
    cancelled: string[];
  }

  function prStore(fx: PrFixture): ReviewRoutingStore {
    const base = makeStore({
      rows: new Map(),
      reviewers: [{ id: REV_A, role: "reviewer" }, { id: STEWARD, role: "devops" }],
      load: new Map(),
      history: new Map(),
      activities: [],
    });
    return {
      ...base,
      listPrCandidates: async () => fx.candidates,
      listKnownPrRepositories: async () => fx.knownRepos,
      listOpenPrRoutingTasks: async () => fx.routed,
      openPrTaskLoadByAgent: async (_company: string, kind: PrRoutingKind) => (kind === "review" ? fx.openReviewLoad : fx.openMergeLoad),
      findAgentIdsByGitHubLogin: async () => [],
      createPrRoutingTask: async (input: CreatePrRoutingTaskInput) => {
        fx.created.push({ title: input.title, kind: input.kind, assigneeAgentId: input.assigneeAgentId, headSha: input.headSha });
        fx.routed.push({ issueId: `task-${input.kind}-${input.number}`, repository: input.repository, number: input.number, kind: input.kind, headSha: input.headSha });
        return { issueId: `task-${input.kind}-${input.number}`, deduplicated: false };
      },
      cancelPrRoutingTask: async ({ issueId }: { issueId: string; companyId: string }) => {
        fx.cancelled.push(issueId);
        fx.routed = fx.routed.filter((task) => task.issueId !== issueId);
        return true;
      },
    } as unknown as ReviewRoutingStore;
  }

  function headState(overrides: Partial<PullRequestHeadState> = {}): PullRequestHeadState {
    return {
      repository: "acme/widgets",
      number: 7,
      open: true,
      draft: false,
      headSha: "aaaaaaaa",
      ci: "green",
      reviewDecision: null,
      fetchFailed: false,
      title: "Add routing",
      url: "https://github.com/acme/widgets/pull/7",
      authorLogin: "author-a",
      baseRef: "main",
      ...overrides,
    };
  }

  function prSetup(
    settings: SettingsOverride = {},
    fx?: Partial<PrFixture> & { headState?: PullRequestHeadState; resolverThrows?: boolean; authorAgents?: string[] },
  ) {
    const fixture: PrFixture = {
      candidates: [{ repository: "acme/widgets", number: 7, headSha: "aaaaaaaa", title: "Add routing", url: null, authorLogin: "author-a", baseRef: "main", draft: false }],
      knownRepos: [],
      routed: [],
      openReviewLoad: new Map(),
      openMergeLoad: new Map(),
      created: [],
      cancelled: [],
      ...fx,
    };
    const state = fx?.headState ?? headState();
    const resolver = {
      resolve: async ({ number }: { repository: string; number: number }) => {
        if (fx?.resolverThrows) throw new Error("resolver exploded");
        return { ...state, number };
      },
      listOpenPullRequests: async () => [],
      resetCache: () => undefined,
    } as unknown as PullRequestHeadResolver;
    const store = prStore(fixture);
    (store as unknown as Record<string, unknown>).findAgentIdsByGitHubLogin = async () => fx?.authorAgents ?? [];
    let current = normalizeReviewRoutingSettings(settings);
    const activities: Array<{ action: string; issueId: string }> = [];
    const wakes: Array<{ agentId: string; issueId: string }> = [];
    const comments: Array<{ issueId: string; body: string }> = [];
    const sweep = createReviewRoutingSweep({
      store,
      prResolver: resolver,
      readSettings: async () => current,
      addComment: async (issueId, body) => { comments.push({ issueId, body }); },
      wakeReviewer: async (agentId, wake) => { wakes.push({ agentId, issueId: wake.issueId }); },
      logActivity: async (entry) => { activities.push({ action: entry.action, issueId: entry.issueId }); },
      log: { info: vi.fn(), warn: vi.fn() },
    });
    return { fixture, sweep, activities, wakes, comments,
      setSettings: (next: SettingsOverride) => { current = normalizeReviewRoutingSettings(next); } };
  }

  it("creates a review task on the first green sighting", async () => {
    const t = prSetup();
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ prScanned: 1, prTasksCreated: 1, stewardTasksCreated: 0, prSuperseded: 0, failed: 0 });
    expect(t.fixture.created).toEqual([
      expect.objectContaining({ title: "Review PR acme/widgets#7: Add routing", kind: "review", assigneeAgentId: REV_A, headSha: "aaaaaaaa" }),
    ]);
    expect(t.activities.map((a) => a.action)).toEqual(expect.arrayContaining([REVIEW_ROUTING_PR_TASK_CREATED_ACTION]));
    expect(t.wakes).toEqual([{ agentId: REV_A, issueId: "task-review-7" }]);
  });

  it("does not re-create while an open task covers the head", async () => {
    const t = prSetup();
    await t.sweep.sweep(NOW, { force: true });
    const second = await t.sweep.sweep(new Date(NOW.getTime() + 60_000), { force: true });
    expect(second.prTasksCreated).toBe(0);
    expect(t.fixture.created).toHaveLength(1);
  });

  it("creates a steward task only on APPROVED", async () => {
    const changes = prSetup({}, { headState: headState({ reviewDecision: "CHANGES_REQUESTED" }) });
    const result = await changes.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ prTasksCreated: 0, stewardTasksCreated: 0 });
    expect(changes.fixture.created).toHaveLength(0);

    const approved = prSetup({}, { headState: headState({ reviewDecision: "APPROVED" }) });
    const approvedResult = await approved.sweep.sweep(NOW, { force: true });
    expect(approvedResult).toMatchObject({ stewardTasksCreated: 1, prTasksCreated: 0 });
    expect(approved.fixture.created).toEqual([expect.objectContaining({ title: "Merge PR acme/widgets#7", kind: "merge" })]);
    expect(approved.activities.map((a) => a.action)).toEqual(expect.arrayContaining([REVIEW_ROUTING_STEWARD_TASK_CREATED_ACTION]));
  });

  it("cancels a task whose recorded head moved on and routes the new head the same pass", async () => {
    const t = prSetup({}, {
      routed: [{ issueId: "old-task", repository: "acme/widgets", number: 7, kind: "review", headSha: "older-sha" }],
      headState: headState({ headSha: "newer-sha" }),
    });
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.prSuperseded).toBe(1);
    expect(result.prTasksCreated).toBe(1);
    expect(t.fixture.cancelled).toEqual(["old-task"]);
    expect(t.comments.some((c) => c.issueId === "old-task" && c.body.includes("newer-sha"))).toBe(true);
    expect(t.fixture.created[0]?.headSha).toBe("newer-sha");
  });

  it("a resolver failure creates nothing and counts no failure", async () => {
    const t = prSetup({}, { headState: headState({ fetchFailed: true, ci: "unknown", open: false }) });
    const result = await t.sweep.sweep(NOW, { force: true });
    // The candidate was looked at, but a failed read must not create, cancel,
    // or inflate `failed` — the desk would misread an outage as a broken lane.
    expect(result).toMatchObject({ prScanned: 1, prTasksCreated: 0, prSuperseded: 0, failed: 0 });
    expect(t.fixture.created).toHaveLength(0);
    expect(t.fixture.cancelled).toHaveLength(0);

    const exploded = prSetup({}, { resolverThrows: true });
    const explodedResult = await exploded.sweep.sweep(NOW, { force: true });
    expect(explodedResult).toMatchObject({ prScanned: 0, prTasksCreated: 0, failed: 0 });
    expect(exploded.fixture.created).toHaveLength(0);
  });

  it("raises a no_reviewer card carrying the PR coordinates when nobody is eligible", async () => {
    const t = prSetup({ reviewerRoles: ["qa"] });
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ prTasksCreated: 0, signaled: 1 });
    expect(readReviewRoutingSignals(COMPANY)).toEqual([
      expect.objectContaining({ kind: "no_reviewer", pr: { repository: "acme/widgets", number: 7, headSha: "aaaaaaaa" } }),
    ]);
  });

  it("skips the PR author's linked agent", async () => {
    const t = prSetup({}, { authorAgents: [REV_A] });
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.prTasksCreated).toBe(0);
    expect(readReviewRoutingSignals(COMPANY)[0]?.kind).toBe("no_reviewer");
  });

  it("pollIntervalSec gates only the PR lane", async () => {
    const t = prSetup({ prWatch: { pollIntervalSec: 300 } });
    await t.sweep.sweep(NOW, { force: true });
    expect(t.fixture.created).toHaveLength(1);
    t.fixture.created.length = 0;
    const second = await t.sweep.sweep(new Date(NOW.getTime() + 61_000));
    expect(second).toMatchObject({ skippedPass: false, prScanned: 0 });
    const far = await t.sweep.sweep(new Date(NOW.getTime() + 301_000));
    expect(far.prScanned).toBe(1);
  });

  it("with prWatch disabled the lane is inert and its cards drop", async () => {
    const t = prSetup();
    await t.sweep.sweep(NOW, { force: true });
    expect(t.fixture.created).toHaveLength(1);
    t.setSettings({ prWatch: { enabled: false } });
    const disabled = await t.sweep.sweep(new Date(NOW.getTime() + 3_600_000), { force: true });
    expect(disabled.prScanned).toBe(0);
    expect(readReviewRoutingSignals(COMPANY)).toEqual([]);
  });

  it("no candidates: the lane scans nothing", async () => {
    const t = prSetup({}, { candidates: [] });
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ prScanned: 0, prTasksCreated: 0 });
  });

  it("counts the per-pass ceiling of new assignments", async () => {
    const t = prSetup({ prWatch: { maxNewAssignmentsPerPass: 1 } }, {
      candidates: [
        { repository: "acme/widgets", number: 7, headSha: "aaaaaaaa", title: null, url: null, authorLogin: null, baseRef: null, draft: false },
        { repository: "acme/widgets", number: 8, headSha: "bbbbbbbb", title: null, url: null, authorLogin: null, baseRef: null, draft: false },
      ],
    });
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.prTasksCreated).toBe(1);
  });
});

describe("settings and pass control", () => {
  it("applies a settings change on the next pass without any restart", async () => {
    const t = setup({ enabled: false });
    t.fixture.rows.set("1", row("1"));
    await t.sweep.sweep(NOW, { force: true });
    expect(t.fixture.rows.get("1")!.assigneeAgentId).toBe(ASSIGNEE);
    t.setSettings({ enabled: true });
    await t.sweep.sweep(NOW, { force: true });
    expect([REV_A, REV_B]).toContain(t.fixture.rows.get("1")!.assigneeAgentId);
  });

  it("drops the cards when the routing is switched off", async () => {
    const t = setup({}, { reviewers: [] });
    t.fixture.rows.set("1", row("1"));
    await t.sweep.sweep(NOW, { force: true });
    expect(readReviewRoutingSignals(COMPANY)).toHaveLength(1);
    t.setSettings({ enabled: false });
    await t.sweep.sweep(NOW, { force: true });
    expect(readReviewRoutingSignals(COMPANY)).toEqual([]);
  });

  it("respects the pass interval and maintenance mode", async () => {
    const t = setup();
    t.fixture.rows.set("1", row("1"));
    expect((await t.sweep.sweep(NOW)).skippedPass).toBe(false);
    expect((await t.sweep.sweep(new Date(NOW.getTime() + 1000))).skippedPass).toBe(true);
    const under = createReviewRoutingSweep({
      store: makeStore(t.fixture),
      readSettings: async () => normalizeReviewRoutingSettings({}),
      addComment: async () => undefined,
      wakeReviewer: async () => undefined,
      logActivity: async () => undefined,
      isUnderMaintenance: async () => true,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect((await under.sweep(NOW, { force: true })).skippedPass).toBe(true);
  });

  it("uses the documented default of 24 hours", () => {
    expect(DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS).toBe(24);
  });
});
