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
import { readReviewRoutingSignals, replaceReviewRoutingSignals, resetReviewRoutingSignals, setImmediateNoReviewerSignal } from "./attention.js";
import type { CreatePrRoutingTaskInput, InReviewIssueRow, PrCandidateRow, PrRoutingKind, ReviewRoutingStore, RoutingHistory } from "./store.js";
import type { PrRoutedTask } from "./pr-policy.js";
import type { RoutingIssue } from "./policy.js";
import { createReviewRoutingSweep, REVIEW_WAKE_MAX_ATTEMPTS, REVIEW_WAKE_MAX_BACKOFF_MS, REVIEW_WAKE_RETRY_BACKOFF_MS } from "./sweep.js";
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
  managerChain?: Map<string, Array<{ id: string; role: string; model?: string | null }>>;
  reviewers: Array<{ id: string; role: string; invokable?: boolean; model?: string | null }>;
  load: Map<string, number>;
  history: Map<string, RoutingHistory>;
  activities: Array<{ action: string; issueId: string; details: Record<string, unknown> }>;
  wakeStates?: Map<string, { activeRun: boolean; pendingWake: boolean; lastWakeAt: Date | null; attempts: number; lastCancelledRunAt?: Date | null }>;
  reviewerActiveRuns?: Map<string, number>;
  escalations: Array<Record<string, unknown>>;
  agentModels?: Map<string, string | null>;
}

function makeStore(fx: Fixture) {
  return {
    listActiveCompanyIds: async () => [COMPANY],
    listInReviewIssues: async () => [...fx.rows.values()],
    listManagerChainReviewerAgents: async (_company: string, engineerId: string, roles: readonly string[]) => {
      return (fx.managerChain?.get(engineerId) ?? []).filter((agent) => roles.includes(agent.role));
    },
    listReviewerAgents: async (_company: string, roles: readonly string[]) => fx.reviewers.filter((agent) => roles.includes(agent.role)),
    getAgentModel: async (_company: string, agentId: string) => fx.agentModels?.get(agentId) ?? null,
    getAgent: async (_company: string, agentId: string) => {
      const found = fx.reviewers.find((agent) => agent.id === agentId);
      return found ?? null;
    },
    loadByAgent: async () => new Map(fx.load),
    countActiveRunsForAgent: async (_companyId: string, agentId: string) => {
      return fx.reviewerActiveRuns?.get(agentId) ?? 0;
    },
    countActiveRunsForIssue: async (
      _companyId: string,
      agentId: string,
      issueId: string,
    ) => {
      const state = fx.wakeStates?.get(issueId);
      if (!state || !state.activeRun) return 0;
      const row = fx.rows.get(issueId);
      if (!row || typeof row.executionState !== "object" || row.executionState === null) return 0;
      const participant = (row.executionState as Record<string, unknown>).currentParticipant as Record<string, unknown> | undefined;
      return participant?.agentId === agentId ? 1 : 0;
    },
    routingHistory: async (_company: string, ids: readonly string[]) => new Map([...fx.history].filter(([id]) => ids.includes(id))),
    reviewWakeState: async ({ issueId }: { companyId: string; issueId: string; reviewerAgentId: string; stageId: string }) => {
      return fx.wakeStates?.get(issueId) ?? { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 };
    },
    recordReviewWakeEscalation: async (entry: Record<string, unknown>) => { fx.escalations?.push(entry); },
    recordReviewWake: async ({ issueId, at, attempt }: { companyId: string; issueId: string; reviewerAgentId: string; stageId: string; at: Date; attempt: number }) => {
      const wake = fx.wakeStates?.get(issueId) ?? { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 };
      fx.wakeStates?.set(issueId, { ...wake, activeRun: false, pendingWake: true, lastWakeAt: at, attempts: attempt });
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
    escalations: [],
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
      if (entry.action === REVIEW_ROUTING_ASSIGNED_ACTION) {
        const previous = fixture.history.get(entry.issueId);
        fixture.history.set(entry.issueId, {
          lastAt: NOW,
          reviewerAgentIds: [...(previous?.reviewerAgentIds ?? []), String(entry.details.reviewerAgentId)],
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
    expect(t.activities).toEqual([]);
    expect(t.fixture.history.get("1")).toBeUndefined();
  });

  it("records one wake activity event for a successful retry", async () => {
    const t = setup({}, { wakeStates: new Map() });
    t.fixture.rows.set("1", pending("1", REV_A));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(1);
    expect(t.fixture.wakeStates!.get("1")).toEqual({ activeRun: false, pendingWake: true, lastWakeAt: NOW, attempts: 1 });
    expect(t.activities).toEqual([]);
  });
  it("records a wake before dispatch; dispatch failures still respect persisted backoff", async () => {
    const t = setup({}, { wakeStates: new Map() });
    t.fixture.rows.set("1", pending("1", REV_A));
    t.wakeReviewer.mockRejectedValueOnce(new Error("dispatch unavailable"));
    const first = await t.sweep.sweep(NOW, { force: true });
    expect(first.failed).toBe(1);
    expect(t.fixture.wakeStates!.get("1")).toEqual({ activeRun: false, pendingWake: true, lastWakeAt: NOW, attempts: 1 });
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

  it("uses the persisted wake time instead of a later issue update", async () => {
    const lastWakeAt = new Date(NOW.getTime() - 31 * 60_000);
    const t = setup({}, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt, attempts: 1 }],
    ]) });
    t.fixture.rows.set("1", pending("1", REV_A, {
      updatedAt: new Date(NOW.getTime() - 2 * 60_000),
    }));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(1);
    expect(t.wakes[0]?.retryAttempt).toBe(2);
  });

  it("reserves the one-dispatch budget before an attempted wake, even when it rejects", async () => {
    const t = setup({}, { wakeStates: new Map() });
    t.fixture.rows.set("1", pending("1", REV_A));
    t.fixture.rows.set("2", pending("2", REV_B));
    t.wakeReviewer.mockRejectedValueOnce(new Error("first dispatch failed"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.failed).toBe(1);
    expect(t.wakeReviewer).toHaveBeenCalledTimes(1);
    expect(t.wakes).toHaveLength(0);
  });

  it("intentional return changes the participant/stage so a later sweep does not wake the former reviewer", async () => {
    const t = setup({}, { wakeStates: new Map() });
    t.fixture.rows.set("1", pending("1", REV_A));
    // Simulate the ordinary returned transition: current participant and stage move off review.
    t.fixture.rows.set("1", { ...pending("1", REV_A), executionState: { status: "pending", currentStageId: "implementation", currentStageType: "work", currentParticipant: { type: "agent", agentId: ASSIGNEE } } });
    expect((await t.sweep.sweep(NOW, { force: true })).woken).toBe(0);
    expect(t.wakeReviewer).not.toHaveBeenCalled();
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
    // Liveness wakes REV_A for "1"; REV_A is then overloaded (12 > queueThreshold 8),
    // so "1" is rebalanced to REV_B and the reassignment wakes REV_B too.
    expect(t.wakes.map(({ agentId, issueId }) => `${agentId}:${issueId}`)).toEqual([`${REV_A}:1`, `${REV_B}:1`]);
  });

  it("does not wake another issue while the reviewer has an active run elsewhere", async () => {
    const t = setup({}, {
      wakeStates: new Map([["1", { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0 }]]),
      reviewerActiveRuns: new Map([[REV_A, 1]]),
    });
    t.fixture.rows.set("1", pending("1", REV_A));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(0);
    expect(t.wakes).toHaveLength(0);
  });

  it("caps exponential retry backoff at 60 minutes and skips exhausted retries", async () => {
    const t = setup({}, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 59 * 60_000), attempts: 5 }],
    ]) });
    expect(REVIEW_WAKE_MAX_BACKOFF_MS).toBe(60 * 60_000);
    expect(Math.min(REVIEW_WAKE_MAX_BACKOFF_MS, REVIEW_WAKE_RETRY_BACKOFF_MS * 2 ** 5)).toBe(60 * 60_000);
    t.fixture.rows.set("1", pending("1", REV_A));
    expect((await t.sweep.sweep(NOW, { force: true })).woken).toBe(0);
    const retryAt = new Date(NOW.getTime() + 60_000);
    expect((await t.sweep.sweep(retryAt, { force: true })).woken).toBe(1);
    expect(t.wakes[0]?.retryAttempt).toBe(6);

    const exhausted = setup({}, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 2 * 60 * 60_000), attempts: REVIEW_WAKE_MAX_ATTEMPTS }],
    ]) });
    exhausted.fixture.rows.set("1", pending("1", REV_A));
    expect((await exhausted.sweep.sweep(NOW, { force: true })).woken).toBe(0);
    expect(exhausted.wakes).toHaveLength(0);
    expect(exhausted.fixture.escalations).toEqual([expect.objectContaining({ companyId: COMPANY, issueId: "1", reviewerAgentId: REV_A, attempts: REVIEW_WAKE_MAX_ATTEMPTS, at: NOW })]);
  });
  it("retries a failed dispatch after ten minutes despite a fresh issue update", async () => {
    const t = setup({}, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 10 * 60_000), attempts: 1 }],
    ]) });
    t.fixture.rows.set("1", pending("1", REV_A, { updatedAt: NOW }));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(1);
    expect(t.wakes[0]?.retryAttempt).toBe(2);
  });

  it("retries a cancelled reviewer run after ten minutes even without an earlier wake marker or on fresh issue update", async () => {
    const t = setup({}, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0, lastCancelledRunAt: new Date(NOW.getTime() - 10 * 60_000) }],
    ]) });
    t.fixture.rows.set("1", pending("1", REV_A, { updatedAt: NOW }));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(1);
    expect(t.wakes[0]?.retryAttempt).toBe(1);
  });

  it("does not retry a cancelled reviewer run before the ten-minute backoff expires", async () => {
    const t = setup({}, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt: null, attempts: 0, lastCancelledRunAt: new Date(NOW.getTime() - 5 * 60_000) }],
    ]) });
    t.fixture.rows.set("1", pending("1", REV_A, { updatedAt: NOW }));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(0);
    expect(t.wakes).toHaveLength(0);
  });

  it("retries repeatedly cancelled reviewer runs on exponential backoff anchored at each cancellation", async () => {
    const t = setup({}, { wakeStates: new Map() });
    t.fixture.rows.set("1", pending("1", REV_A, { updatedAt: NOW }));

    // Run 1 was cancelled at T0 (30m ago)
    const t0 = new Date(NOW.getTime() - 30 * 60_000);
    t.fixture.wakeStates!.set("1", {
      activeRun: false,
      pendingWake: false,
      lastWakeAt: null,
      attempts: 0,
      lastCancelledRunAt: t0,
    });

    // 5 minutes after first cancel: within 10m backoff -> no wake
    const at5m = new Date(t0.getTime() + 5 * 60_000);
    expect((await t.sweep.sweep(at5m, { force: true })).woken).toBe(0);

    // 10 minutes after first cancel: reaches 10m backoff -> wakes attempt 1
    const at10m = new Date(t0.getTime() + 10 * 60_000);
    const res1 = await t.sweep.sweep(at10m, { force: true });
    expect(res1.woken).toBe(1);
    expect(t.wakes[0]?.retryAttempt).toBe(1);

    // Run was launched and cancelled at T1 = t0 + 12m
    const t1 = new Date(t0.getTime() + 12 * 60_000);
    t.fixture.wakeStates!.set("1", {
      activeRun: false,
      pendingWake: false,
      lastWakeAt: at10m,
      attempts: 1,
      lastCancelledRunAt: t1,
    });

    // 5 minutes after second cancel: within 10m backoff -> no wake
    const at17m = new Date(t1.getTime() + 5 * 60_000);
    expect((await t.sweep.sweep(at17m, { force: true })).woken).toBe(0);

    // 10 minutes after second cancel: reaches 10m backoff -> wakes attempt 2
    const at22m = new Date(t1.getTime() + 10 * 60_000);
    const res2 = await t.sweep.sweep(at22m, { force: true });
    expect(res2.woken).toBe(1);
    expect(t.wakes[1]?.retryAttempt).toBe(2);

    // Second retry run was launched and cancelled again at T2 = t1 + 12m
    const t2 = new Date(t1.getTime() + 12 * 60_000);
    t.fixture.wakeStates!.set("1", {
      activeRun: false,
      pendingWake: false,
      lastWakeAt: at22m,
      attempts: 2,
      lastCancelledRunAt: t2,
    });

    // Backoff for attempt 2 is 20 minutes (10m * 2^1)
    // 15 minutes after third cancel: within 20m backoff -> no wake
    const at37m = new Date(t2.getTime() + 15 * 60_000);
    expect((await t.sweep.sweep(at37m, { force: true })).woken).toBe(0);

    // 20 minutes after third cancel: reaches 20m backoff -> wakes attempt 3
    const at42m = new Date(t2.getTime() + 20 * 60_000);
    const res3 = await t.sweep.sweep(at42m, { force: true });
    expect(res3.woken).toBe(1);
    expect(t.wakes[2]?.retryAttempt).toBe(3);
  });

  it("does not wake a review before 30 minutes or inside retry backoff", async () => {
    const t = setup({ maxLoadPerReviewer: 2 }, { wakeStates: new Map([
      ["1", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 5 * 60_000), attempts: 1 }],
      ["2", { activeRun: false, pendingWake: false, lastWakeAt: new Date(NOW.getTime() - 2 * 60_000), attempts: 1 }],
    ]) });
    t.fixture.rows.set("1", pending("1", REV_A, { updatedAt: new Date(NOW.getTime() - 20 * 60_000) }));
    t.fixture.rows.set("2", pending("2", REV_B));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.woken).toBe(0);
    expect(t.wakes).toHaveLength(0);
  });
});

describe("assignment", () => {
  it("does not route until the reviewer-less review has aged fifteen minutes", async () => {
    const t = setup();
    t.fixture.rows.set("fresh", row("fresh", { updatedAt: NOW }));
    await t.sweep.sweep(NOW, { force: true });
    expect(t.fixture.rows.get("fresh")?.assigneeAgentId).toBe(ASSIGNEE);
    expect(t.wakes).toHaveLength(0);

    t.fixture.rows.set("aged", row("aged", { updatedAt: new Date(NOW.getTime() - 16 * 60 * 1000) }));
    await t.sweep.sweep(NOW, { force: true });
    expect(t.fixture.rows.get("aged")?.assigneeAgentId).toBe(REV_A);
    expect(t.wakes).toEqual([expect.objectContaining({ agentId: REV_A, issueId: "aged" })]);
  });

  it("picks the least loaded reviewer or lead from the pool", async () => {
    const t = setup({}, {
      reviewers: [
        { id: REV_A, role: "reviewer" },
        { id: REV_B, role: "lead" },
      ],
      load: new Map([[REV_A, 5], [REV_B, 1]]),
    });
    t.fixture.rows.set("least-loaded", row("least-loaded"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ assigned: 1, signaled: 0, failed: 0 });
    expect(t.fixture.rows.get("least-loaded")!.assigneeAgentId).toBe(REV_B);
    expect(t.activities[0]?.details.reviewerAgentId).toBe(REV_B);
  });

  it("uses the global pool only when the manager chain has no eligible candidate", async () => {
    const t = setup({}, { managerChain: new Map([[ASSIGNEE, []]]), reviewers: [{ id: REV_B, role: "reviewer" }] });
    t.fixture.rows.set("fallback", row("fallback"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ assigned: 1, signaled: 0, failed: 0 });
    expect(t.fixture.rows.get("fallback")!.assigneeAgentId).toBe(REV_B);
  });

  it("keeps an explicitly assigned reviewer unchanged", async () => {
    const t = setup();
    t.fixture.rows.set("already-assigned", row("already-assigned", {
      executionPolicy: { stages: [{ id: "review", type: "review", participants: [{ type: "agent", agentId: REV_A }] }] },
    }));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ assigned: 0, signaled: 0, failed: 0 });
    expect(t.fixture.rows.get("already-assigned")!.assigneeAgentId).toBe(ASSIGNEE);
    expect(t.activities).toHaveLength(0);
  });

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

  it("filters out reviewers whose model matches the author's model", async () => {
    const t = setup(
      {},
      {
        reviewers: [
          { id: REV_A, role: "reviewer", invokable: true, model: "model-author" },
          { id: REV_B, role: "reviewer", invokable: true, model: "model-other" },
        ],
        load: new Map([[REV_A, 0], [REV_B, 1]]),
        agentModels: new Map([[AUTHOR, "model-author"]]),
      },
    );
    t.fixture.rows.set("1", row("1"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ assigned: 1, signaled: 0, failed: 0 });
    // REV_A has lower load (0) but matches author model; REV_B is assigned.
    expect(t.fixture.rows.get("1")!.assigneeAgentId).toBe(REV_B);
  });

  it("excludes the task author and current assignee from reviewer candidates", async () => {
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
    t.fixture.rows.set("authored", row("authored", { assigneeAgentId: null }));
    t.fixture.rows.set("assigned", row("assigned"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ assigned: 2, signaled: 0 });
    expect(t.fixture.rows.get("authored")?.assigneeAgentId).toBe(ASSIGNEE);
    expect(t.fixture.rows.get("assigned")?.assigneeAgentId).toBe(REV_A);
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
    expect(t.activities).toHaveLength(1);
    expect(t.activities).toEqual([
      expect.objectContaining({ action: REVIEW_ROUTING_ASSIGNED_ACTION }),
    ]);
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
  it("sets one immediate no_reviewer signal until a reviewer is assigned", () => {
    const signal = {
      kind: "no_reviewer" as const,
      issueId: "1",
      companyId: COMPANY,
      identifier: "T-1",
      title: "Task 1",
      since: NOW.toISOString(),
      hoursInReview: null,
    };
    setImmediateNoReviewerSignal(signal, true);
    setImmediateNoReviewerSignal({ ...signal, since: new Date(NOW.getTime() + 1000).toISOString() }, true);
    expect(readReviewRoutingSignals(COMPANY)).toEqual([
      expect.objectContaining({ kind: "no_reviewer", issueId: "1", since: NOW.toISOString() }),
    ]);
    setImmediateNoReviewerSignal(signal, false);
    expect(readReviewRoutingSignals(COMPANY)).toEqual([]);
  });

  it("clears stale immediate cards when a successful sweep replaces the company's snapshot", () => {
    const signal = {
      kind: "no_reviewer" as const,
      issueId: "task-1",
      companyId: COMPANY,
      identifier: "T-1",
      title: "Task 1",
      since: NOW.toISOString(),
      hoursInReview: null,
    };
    setImmediateNoReviewerSignal(signal, true);
    replaceReviewRoutingSignals(COMPANY, []);

    expect(readReviewRoutingSignals(COMPANY)).toEqual([]);
  });

  it("sweep clears an immediate card after the task acquires a reviewer", async () => {
    const t = setup({ enabled: true }, { reviewers: [{ id: REV_A, role: "reviewer" }] });
    const signal = {
      kind: "no_reviewer" as const,
      issueId: "task-1",
      companyId: COMPANY,
      identifier: "T-1",
      title: "Task 1",
      since: NOW.toISOString(),
      hoursInReview: null,
    };
    setImmediateNoReviewerSignal(signal, true);
    t.fixture.rows.set("task-1", row("task-1"));

    await t.sweep.sweep(NOW, { force: true });

    expect(t.fixture.rows.get("task-1")?.assigneeAgentId).toBe(REV_A);
    expect(readReviewRoutingSignals(COMPANY)).toEqual([]);
  });
  it("sweep clears an immediate card when the task is no longer pending review", async () => {
    const t = setup();
    const signal = {
      kind: "no_reviewer" as const,
      issueId: "task-1",
      companyId: COMPANY,
      identifier: "T-1",
      title: "Task 1",
      since: NOW.toISOString(),
      hoursInReview: null,
    };
    setImmediateNoReviewerSignal(signal, true);
    t.fixture.rows.set("task-1", row("task-1", { status: "done" }));

    await t.sweep.sweep(NOW, { force: true });

    expect(readReviewRoutingSignals(COMPANY)).toEqual([]);
  });
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

  describe("overload rebalancing and escalation", () => {
    it("reassigns from an overloaded participant to a free participant", async () => {
      const t = setup({}, {
        reviewers: [
          { id: REV_A, role: "reviewer" },
          { id: REV_B, role: "lead" },
        ],
        load: new Map([
          [REV_A, 12], // > default queueThreshold (8)
          [REV_B, 1],
        ]),
      });
      const policy = { stages: [{ id: "s", type: "review", participants: [{ type: "agent", agentId: REV_A }] }] };
      const state = {
        status: "pending",
        currentStageId: "s",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: REV_A },
        returnAssignee: { type: "agent", agentId: ASSIGNEE },
      };
      t.fixture.rows.set("overloaded-task", row("overloaded-task", {
        assigneeAgentId: REV_A,
        executionPolicy: policy,
        executionState: state,
      }));
      const result = await t.sweep.sweep(NOW, { force: true });
      expect(result).toMatchObject({ reassigned: 1 });
      const updated = t.fixture.rows.get("overloaded-task")!;
      expect(updated.assigneeAgentId).toBe(REV_B);
      expect((updated.executionState as any).currentParticipant.agentId).toBe(REV_B);
      // Confirms decisions/state were not lost
      expect((updated.executionState as any).status).toBe("pending");
      expect((updated.executionState as any).returnAssignee.agentId).toBe(ASSIGNEE);
      expect(t.comments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            issueId: "overloaded-task",
            body: expect.stringContaining("threshold 8"),
          }),
        ]),
      );
      expect(t.activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: REVIEW_ROUTING_REASSIGNED_ACTION,
            issueId: "overloaded-task",
            details: expect.objectContaining({
              reason: "reviewer-queue-overload",
              previousReviewerAgentId: REV_A,
              reviewerAgentId: REV_B,
            }),
          }),
        ]),
      );
    });

    it("does not select the PR author when rebalancing or assigning", async () => {
      const t = setup({}, {
        reviewers: [
          { id: REV_A, role: "reviewer" },
          { id: ASSIGNEE, role: "lead" }, // ASSIGNEE is PR author / returnAssignee
          { id: REV_B, role: "reviewer" },
        ],
        load: new Map([
          [REV_A, 10],
          [ASSIGNEE, 0], // author has lowest load
          [REV_B, 2],
        ]),
      });
      const policy = { stages: [{ id: "s", type: "review", participants: [{ type: "agent", agentId: REV_A }] }] };
      const state = {
        status: "pending",
        currentStageId: "s",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: REV_A },
        returnAssignee: { type: "agent", agentId: ASSIGNEE },
      };
      t.fixture.rows.set("task-with-author", row("task-with-author", {
        assigneeAgentId: REV_A,
        executionPolicy: policy,
        executionState: state,
      }));
      const result = await t.sweep.sweep(NOW, { force: true });
      expect(result).toMatchObject({ reassigned: 1 });
      const updated = t.fixture.rows.get("task-with-author")!;
      // Should pick REV_B, NOT the author ASSIGNEE despite ASSIGNEE having 0 load
      expect(updated.assigneeAgentId).toBe(REV_B);
      expect((updated.executionState as any).currentParticipant.agentId).toBe(REV_B);
    });

    it("leaves an escalated review stage (changesRequestedCount >= 3) untouched", async () => {
      const t = setup({}, {
        reviewers: [
          { id: REV_A, role: "reviewer" },
          { id: REV_B, role: "lead" },
        ],
        load: new Map([
          [REV_A, 15], // heavily overloaded
          [REV_B, 0],
        ]),
      });
      const policy = {
        stages: [{
          id: "s",
          type: "review",
          participants: [{ type: "agent", agentId: REV_A }],
          changesRequestedCount: 3,
        }],
      };
      const state = {
        status: "pending",
        currentStageId: "s",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: REV_A },
        returnAssignee: { type: "agent", agentId: ASSIGNEE },
        changesRequestedCount: 3,
      };
      t.fixture.rows.set("escalated-task", row("escalated-task", {
        assigneeAgentId: REV_A,
        executionPolicy: policy,
        executionState: state,
      }));
      const result = await t.sweep.sweep(NOW, { force: true });
      expect(result).toMatchObject({ reassigned: 0 });
      expect(t.fixture.rows.get("escalated-task")!.assigneeAgentId).toBe(REV_A);
    });
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
      escalations: [],
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
