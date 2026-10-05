// myrmidon(REVIEW-ROUTING): the sweep against a fake store — assignment by
// least load, the attention signal when nobody is available, the overdue
// reassignment, settings applied on the next pass, and idempotency.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS,
  REVIEW_ROUTING_ASSIGNED_ACTION,
  REVIEW_ROUTING_REASSIGNED_ACTION,
  normalizeReviewRoutingSettings,
  type ReviewRoutingSettings,
} from "@paperclipai/shared";
import { readReviewRoutingSignals, resetReviewRoutingSignals } from "./attention.js";
import type { InReviewIssueRow, ReviewRoutingStore, RoutingHistory } from "./store.js";
import { createReviewRoutingSweep } from "./sweep.js";

const COMPANY = "company-1";
const AUTHOR = "aaaaaaaa-0000-4000-8000-000000000001";
const ASSIGNEE = "aaaaaaaa-0000-4000-8000-000000000002";
const REV_A = "bbbbbbbb-0000-4000-8000-000000000001";
const REV_B = "bbbbbbbb-0000-4000-8000-000000000002";
const NOW = new Date("2026-03-10T12:00:00Z");

function row(id: string, overrides: Partial<InReviewIssueRow> = {}): InReviewIssueRow {
  return {
    id,
    companyId: COMPANY,
    identifier: `T-${id}`,
    title: `Task ${id}`,
    status: "in_review",
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
}

function makeStore(fx: Fixture): ReviewRoutingStore {
  return {
    listActiveCompanyIds: async () => [COMPANY],
    listInReviewIssues: async () => [...fx.rows.values()],
    listReviewerAgents: async (_company, roles) => fx.reviewers.filter((agent) => roles.includes(agent.role)),
    loadByAgent: async () => new Map(fx.load),
    routingHistory: async (_company, ids) => new Map([...fx.history].filter(([id]) => ids.includes(id))),
    applyPatch: async ({ issueId, guard, build }) => {
      const current = fx.rows.get(issueId);
      if (!current || !guard(current)) return null;
      const patch = build(current);
      if (!patch) return null;
      const next = { ...current, ...(patch as Partial<InReviewIssueRow>) };
      fx.rows.set(issueId, next as InReviewIssueRow);
      return { executionState: (next.executionState as Record<string, unknown>) ?? null };
    },
  };
}

function setup(settings: Partial<ReviewRoutingSettings> = {}, fx?: Partial<Fixture>) {
  const fixture: Fixture = {
    rows: new Map(),
    reviewers: [
      { id: REV_A, role: "reviewer" },
      { id: REV_B, role: "reviewer" },
    ],
    load: new Map(),
    history: new Map(),
    ...fx,
  };
  let current = normalizeReviewRoutingSettings(settings);
  const activities: Array<{ action: string; issueId: string; details: Record<string, unknown> }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const wakes: Array<{ agentId: string; issueId: string; executionStage: Record<string, unknown> }> = [];
  const wakeReviewer = vi.fn(async (agentId: string, wake: { issueId: string; executionStage: Record<string, unknown> }) => {
    wakes.push({ agentId, issueId: wake.issueId, executionStage: wake.executionStage });
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
      // The real log is what the store reads the anchor from.
      const previous = fixture.history.get(entry.issueId);
      fixture.history.set(entry.issueId, {
        lastAt: NOW,
        reviewerAgentIds: [...(previous?.reviewerAgentIds ?? []), String(entry.details.reviewerAgentId)],
      });
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
    setSettings: (next: Partial<ReviewRoutingSettings>) => {
      current = normalizeReviewRoutingSettings(next);
    },
  };
}

beforeEach(() => resetReviewRoutingSignals());

describe("assignment", () => {
  it("assigns the least loaded reviewer, comments, logs and wakes it", async () => {
    const t = setup({}, { load: new Map([[REV_A, 3], [REV_B, 1]]) });
    t.fixture.rows.set("1", row("1"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result).toMatchObject({ assigned: 1, signaled: 0, failed: 0 });
    const updated = t.fixture.rows.get("1")!;
    expect(updated.assigneeAgentId).toBe(REV_B);
    expect((updated.executionState as Record<string, any>).currentParticipant.agentId).toBe(REV_B);
    expect(t.activities).toEqual([
      expect.objectContaining({ action: REVIEW_ROUTING_ASSIGNED_ACTION, issueId: "1" }),
    ]);
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
    expect(t.activities).toHaveLength(1);
  });

  it("does not undo the assignment when the wake fails", async () => {
    const t = setup();
    t.wakeReviewer.mockRejectedValueOnce(new Error("agent over budget"));
    t.fixture.rows.set("1", row("1"));
    const result = await t.sweep.sweep(NOW, { force: true });
    expect(result.assigned).toBe(1);
    expect(t.activities).toHaveLength(1);
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
    expect(t.activities.map((entry) => entry.action)).toEqual([
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
