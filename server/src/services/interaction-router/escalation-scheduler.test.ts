import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import {
  agentWakeupRequests,
  interactionEscalations,
  issueThreadInteractions,
} from "@myrmidon/db";
import {
  createInteractionEscalationSweep,
  escalateInteractionStep,
  type DueEscalationItem,
  type EscalationStepResult,
} from "./escalation-scheduler.js";

interface MockCard {
  id: string;
  companyId: string;
  issueId: string;
  kind: string;
  routeType: string;
  status: string;
  escalationLevel: number;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  addresseeQueue: string | null;
  sourceCommentId: string | null;
  sourceRunId: string | null;
  escalationChain: Array<{
    recipient:
      | { agentId: string }
      | { userId: string }
      | { serviceQueue: string };
    afterMinutes: number;
  }>;
  timeoutAt?: Date;
  updatedAt?: Date;
}

function createSampleCard(overrides: Partial<MockCard> = {}): MockCard {
  return {
    id: "interaction-card-1",
    companyId: "company-100",
    issueId: "issue-200",
    kind: "ask_user_questions",
    routeType: "decision",
    status: "pending",
    escalationLevel: 0,
    addresseeAgentId: "agent-lead",
    addresseeUserId: null,
    addresseeQueue: null,
    sourceCommentId: "comment-300",
    sourceRunId: "run-400",
    escalationChain: [
      { recipient: { agentId: "agent-lead" }, afterMinutes: 0 },
      { recipient: { agentId: "agent-architect" }, afterMinutes: 15 },
      { recipient: { agentId: "agent-secondary" }, afterMinutes: 30 },
      { recipient: { serviceQueue: "operators" }, afterMinutes: 60 },
    ],
    ...overrides,
  };
}

interface MockDbState {
  card: MockCard | null;
  escalationAudits: any[];
  wakeupRequests: any[];
}

function createMockEscalationDb(initialCard?: MockCard) {
  const state: MockDbState = {
    card: initialCard ? { ...initialCard } : null,
    escalationAudits: [],
    wakeupRequests: [],
  };

  const makeInsertResult = (val: any, target: any[]) => {
    target.push(val);
    const promise = Promise.resolve();
    (promise as any).onConflictDoNothing = () => promise;
    return promise;
  };

  const tx: any = {
    select: () => ({
      from: (_table: any) => ({
        where: (_condition: any) => ({
          for: (_mode: any) => Promise.resolve(state.card ? [state.card] : []),
        }),
      }),
    }),
    update: (_table: any) => ({
      set: (values: any) => ({
        where: (_condition: any) => {
          if (state.card) {
            Object.assign(state.card, values);
          }
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: any) => ({
      values: (val: any) => {
        if (
          table === interactionEscalations ||
          val.reason === "timeout" ||
          val.fromRecipient
        ) {
          return makeInsertResult(val, state.escalationAudits);
        }
        return makeInsertResult(val, state.wakeupRequests);
      },
    }),
  };

  const db: any = {
    transaction: async (cb: (tx: any) => Promise<any>) => cb(tx),
  };

  return { db: db as Db, state };
}

describe("interaction-router escalation scheduler: sweep contracts", () => {
  it("processes overdue cards in batches and reports aggregated metrics", async () => {
    const batches: DueEscalationItem[][] = [
      [
        { interactionId: "card-1", nextLevel: 1 },
        { interactionId: "card-2", nextLevel: 1 },
      ],
      [{ interactionId: "card-3", nextLevel: 2 }],
      [],
    ];

    const selectDue = vi.fn(async (_db, _now, _limit) => {
      return batches.shift() ?? [];
    });

    const stepCalls: Array<{ id: string; level: number }> = [];
    const escalateStep = vi.fn(async (_db, interactionId: string, level: number): Promise<EscalationStepResult> => {
      stepCalls.push({ id: interactionId, level });
      return "escalated";
    });

    const fakeDb = {} as Db;
    const sweep = createInteractionEscalationSweep({
      db: fakeDb,
      intervalSec: 0,
      selectDueEscalations: selectDue,
      escalateInteractionStep: escalateStep,
    });

    const result = await sweep();

    expect(result).toEqual({
      due: 3,
      escalated: 3,
      unchanged: 0,
      failed: 0,
      skipped: false,
    });
    expect(stepCalls).toEqual([
      { id: "card-1", level: 1 },
      { id: "card-2", level: 1 },
      { id: "card-3", level: 2 },
    ]);
  });

  it("handles unchanged and failed steps without interrupting the sweep pass", async () => {
    const selectDue = vi
      .fn()
      .mockResolvedValueOnce([
        { interactionId: "card-escalated", nextLevel: 1 },
        { interactionId: "card-unchanged", nextLevel: 1 },
        { interactionId: "card-failed", nextLevel: 1 },
      ])
      .mockResolvedValueOnce([]);

    const escalateStep = vi.fn(async (_db, interactionId: string) => {
      if (interactionId === "card-failed") {
        throw new Error("Lock conflict or db transient error");
      }
      if (interactionId === "card-unchanged") {
        return "unchanged" as EscalationStepResult;
      }
      return "escalated" as EscalationStepResult;
    });

    const sweep = createInteractionEscalationSweep({
      db: {} as Db,
      intervalSec: 0,
      selectDueEscalations: selectDue,
      escalateInteractionStep: escalateStep,
    });

    const result = await sweep();

    expect(result).toEqual({
      due: 3,
      escalated: 1,
      unchanged: 1,
      failed: 1,
      skipped: false,
    });
  });

  it("deduplicates concurrent sweep invocations to a single active pass", async () => {
    let resolveSelect: (items: DueEscalationItem[]) => void;
    const selectPromise = new Promise<DueEscalationItem[]>((resolve) => {
      resolveSelect = resolve;
    });

    const selectDue = vi.fn(() => selectPromise);
    const escalateStep = vi.fn(async () => "escalated" as EscalationStepResult);

    const sweep = createInteractionEscalationSweep({
      db: {} as Db,
      intervalSec: 0,
      selectDueEscalations: selectDue,
      escalateInteractionStep: escalateStep,
    });

    const pass1 = sweep();
    const pass2 = sweep();

    // Resolving the batch
    resolveSelect!([
      { interactionId: "card-concurrent", nextLevel: 1 },
    ]);

    // Next pass for the loop termination
    selectDue.mockResolvedValueOnce([]);

    const [res1, res2] = await Promise.all([pass1, pass2]);
    expect(res1).toBe(res2);
    expect(res1.due).toBe(1);
    expect(res1.escalated).toBe(1);
  });

  it("throttles invocations within the configured intervalSec unless force is true", async () => {
    const selectDue = vi.fn().mockResolvedValue([]);
    const baseTime = new Date("2026-11-03T12:00:00Z");

    const sweep = createInteractionEscalationSweep({
      db: {} as Db,
      intervalSec: 60,
      now: () => baseTime,
      selectDueEscalations: selectDue,
    });

    const first = await sweep();
    expect(first.skipped).toBe(false);
    expect(selectDue).toHaveBeenCalledTimes(1);

    // Call 10 seconds later: should be throttled
    const throttled = await sweep({
      now: new Date("2026-11-03T12:00:10Z"),
    });
    expect(throttled).toEqual({
      due: 0,
      escalated: 0,
      unchanged: 0,
      failed: 0,
      skipped: true,
      reason: "interval_throttled",
    });
    expect(selectDue).toHaveBeenCalledTimes(1);

    // Call with force: true: should run despite throttle window
    const forced = await sweep({
      now: new Date("2026-11-03T12:00:10Z"),
      force: true,
    });
    expect(forced.skipped).toBe(false);
    expect(selectDue).toHaveBeenCalledTimes(2);

    // Call after 60s window: should run
    const afterWindow = await sweep({
      now: new Date("2026-11-03T12:01:15Z"),
    });
    expect(afterWindow.skipped).toBe(false);
    expect(selectDue).toHaveBeenCalledTimes(3);
  });

  it("bypasses DB query and skips pass when enabled is false", async () => {
    const selectDue = vi.fn();
    const sweep = createInteractionEscalationSweep({
      db: {} as Db,
      enabled: false,
      selectDueEscalations: selectDue,
    });

    const result = await sweep();
    expect(result).toEqual({
      due: 0,
      escalated: 0,
      unchanged: 0,
      failed: 0,
      skipped: true,
      reason: "disabled",
    });
    expect(selectDue).not.toHaveBeenCalled();
  });

  it("passes custom batchSize to selectDueEscalations", async () => {
    const selectDue = vi.fn().mockResolvedValue([]);
    const sweep = createInteractionEscalationSweep({
      db: {} as Db,
      batchSize: 25,
      intervalSec: 0,
      selectDueEscalations: selectDue,
    });

    await sweep();
    expect(selectDue).toHaveBeenCalledWith(expect.anything(), expect.any(Date), 25);
  });
});

describe("interaction-router escalation: card status transitions and event generation contracts", () => {
  it("escalates card from level 0 (lead) to level 1 (architect) and emits wake event", async () => {
    const card = createSampleCard();
    const { db, state } = createMockEscalationDb(card);

    const result = await escalateInteractionStep(db, card.id, 1);
    expect(result).toBe("escalated");

    // Card status & attributes transition
    expect(state.card?.escalationLevel).toBe(1);
    expect(state.card?.addresseeAgentId).toBe("agent-architect");
    expect(state.card?.addresseeUserId).toBeNull();
    expect(state.card?.addresseeQueue).toBeNull();

    // TimeoutAt recalculated for step 2 (afterMinutes 30 - step 1 afterMinutes 15 = 15m delay)
    expect(state.card?.timeoutAt).toBeDefined();
    const now = new Date();
    const expectedDelayMs = 15 * 60_000;
    const diff = state.card!.timeoutAt!.getTime() - now.getTime();
    expect(diff).toBeGreaterThanOrEqual(expectedDelayMs - 5_000);
    expect(diff).toBeLessThanOrEqual(expectedDelayMs + 5_000);

    // Audit log entry in interactionEscalations
    expect(state.escalationAudits).toHaveLength(1);
    expect(state.escalationAudits[0]).toMatchObject({
      companyId: "company-100",
      interactionId: card.id,
      level: 1,
      fromRecipient: { agentId: "agent-lead" },
      toRecipient: { agentId: "agent-architect" },
      reason: "timeout",
    });

    // Wakeup request event generated for the new agent recipient
    expect(state.wakeupRequests).toHaveLength(1);
    expect(state.wakeupRequests[0]).toMatchObject({
      companyId: "company-100",
      agentId: "agent-architect",
      source: "automation",
      triggerDetail: "system",
      reason: "interaction_pending",
      status: "queued",
      idempotencyKey: `interaction-pending:${card.id}:level:1`,
      requestedByActorType: "system",
      requestedByActorId: "interaction-escalation",
      payload: {
        issueId: "issue-200",
        interactionId: card.id,
        interactionKind: "ask_user_questions",
        sourceCommentId: "comment-300",
        sourceRunId: "run-400",
        mutation: "interaction",
        escalationLevel: 1,
        escalationWake: {
          wakeIdempotencyKey: `interaction-pending:${card.id}:level:1`,
          contextSnapshot: {
            issueId: "issue-200",
            taskId: "issue-200",
            interactionId: card.id,
            interactionKind: "ask_user_questions",
            escalationLevel: 1,
            wakeReason: "interaction_pending",
            source: "issue.interaction.escalated",
          },
        },
      },
    });
  });

  it("escalates card to terminal step (service queue), setting terminal timeout and omitting wake", async () => {
    const card = createSampleCard({
      escalationLevel: 2,
      addresseeAgentId: "agent-secondary",
    });
    const { db, state } = createMockEscalationDb(card);

    // Escalate to level 3 (terminal: operators queue)
    const result = await escalateInteractionStep(db, card.id, 3);
    expect(result).toBe("escalated");

    // Transition to queue recipient
    expect(state.card?.escalationLevel).toBe(3);
    expect(state.card?.addresseeAgentId).toBeNull();
    expect(state.card?.addresseeUserId).toBeNull();
    expect(state.card?.addresseeQueue).toBe("operators");

    // Terminal timeout date set to 9999-12-31T23:59:59.000Z
    expect(state.card?.timeoutAt?.toISOString()).toBe("9999-12-31T23:59:59.000Z");

    // Audit log recorded
    expect(state.escalationAudits).toHaveLength(1);
    expect(state.escalationAudits[0]).toMatchObject({
      companyId: "company-100",
      interactionId: card.id,
      level: 3,
      fromRecipient: { agentId: "agent-secondary" },
      toRecipient: { serviceQueue: "operators" },
      reason: "timeout",
    });

    // NO agent wakeup request generated for queue recipient
    expect(state.wakeupRequests).toHaveLength(0);
  });

  it("returns unchanged when card is not pending or already at/above requested level", async () => {
    // Card already resolved
    const resolvedCard = createSampleCard({ status: "resolved" });
    const { db: dbResolved, state: stateResolved } = createMockEscalationDb(resolvedCard);
    expect(await escalateInteractionStep(dbResolved, resolvedCard.id, 1)).toBe("unchanged");
    expect(stateResolved.escalationAudits).toHaveLength(0);
    expect(stateResolved.wakeupRequests).toHaveLength(0);

    // Card already at level 1, asked to escalate to level 1
    const currentCard = createSampleCard({ escalationLevel: 1 });
    const { db: dbCurrent, state: stateCurrent } = createMockEscalationDb(currentCard);
    expect(await escalateInteractionStep(dbCurrent, currentCard.id, 1)).toBe("unchanged");
    expect(stateCurrent.escalationAudits).toHaveLength(0);
    expect(stateCurrent.wakeupRequests).toHaveLength(0);

    // Card at terminal step, requested level beyond chain
    const terminalCard = createSampleCard({ escalationLevel: 3 });
    const { db: dbTerminal } = createMockEscalationDb(terminalCard);
    expect(await escalateInteractionStep(dbTerminal, terminalCard.id, 4)).toBe("unchanged");
  });

  it("enforces escalation level ordering and rejects level skipping", async () => {
    const card = createSampleCard({ escalationLevel: 0 });
    const { db } = createMockEscalationDb(card);

    // Attempting to jump from level 0 to level 2
    await expect(escalateInteractionStep(db, card.id, 2)).rejects.toThrow(
      "Escalation must advance one level",
    );
  });

  it("validates escalation level parameter", async () => {
    const card = createSampleCard();
    const { db } = createMockEscalationDb(card);

    await expect(escalateInteractionStep(db, card.id, 0)).rejects.toThrow(
      "Invalid escalation level",
    );
    await expect(escalateInteractionStep(db, card.id, -1)).rejects.toThrow(
      "Invalid escalation level",
    );
    await expect(escalateInteractionStep(db, card.id, 1.5)).rejects.toThrow(
      "Invalid escalation level",
    );
  });

  it("rejects non-existent cards with Interaction not found", async () => {
    const { db } = createMockEscalationDb(); // No card

    await expect(escalateInteractionStep(db, "non-existent-id", 1)).rejects.toThrow(
      "Interaction not found",
    );
  });

  it("enforces terminal step in escalation chain to be a serviceQueue", async () => {
    const invalidChainCard = createSampleCard({
      escalationChain: [
        { recipient: { agentId: "agent-lead" }, afterMinutes: 0 },
        { recipient: { agentId: "agent-architect" }, afterMinutes: 15 },
        // Terminal step is an agent, not a serviceQueue
      ],
    });
    const { db } = createMockEscalationDb(invalidChainCard);

    await expect(escalateInteractionStep(db, invalidChainCard.id, 1)).rejects.toThrow(
      "Escalation chain must end in a service queue",
    );
  });

  it("enforces code_review route constraint: code_review cannot escalate to a human user", async () => {
    const codeReviewCard = createSampleCard({
      routeType: "code_review",
      escalationChain: [
        { recipient: { agentId: "agent-lead" }, afterMinutes: 0 },
        { recipient: { userId: "human-user" }, afterMinutes: 15 },
        { recipient: { serviceQueue: "operators" }, afterMinutes: 30 },
      ],
    });
    const { db } = createMockEscalationDb(codeReviewCard);

    await expect(escalateInteractionStep(db, codeReviewCard.id, 1)).rejects.toThrow(
      "Invalid escalation recipient",
    );
  });

  it("rejects escalation when card has no current addressee to escalate from", async () => {
    const cardNoAddressee = createSampleCard({
      addresseeAgentId: null,
      addresseeUserId: null,
      addresseeQueue: null,
    });
    const { db } = createMockEscalationDb(cardNoAddressee);

    await expect(escalateInteractionStep(db, cardNoAddressee.id, 1)).rejects.toThrow(
      "Card has no current addressee",
    );
  });
});
