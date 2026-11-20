import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { heartbeatService } from "../services/heartbeat.js";
import {
  createStaleInteractionRewakeSweep,
  STALE_INTERACTION_WAKE_MS,
  type StaleInteractionRewake,
} from "../myrmidon/stale-interaction-rewake-sweep.js";
import {
  DEFAULT_MAX_DAILY_INTERACTION_WAKE_RUNS,
  readInteractionPendingWakeCardId,
  resolveInteractionWakeBypassCap,
} from "../myrmidon/interaction-wake-daily-limit.js";

/**
 * INTERACTION-WAKES-DAILY-LIMIT: a pending question card wakes its addressee even
 * when the addressee has used its daily run limit, and a card whose wake was lost
 * is announced again by the scheduler sweep (at most once per 30 minutes).
 */
describe("interaction wake helpers", () => {
  it("reads the card id only from an interaction_pending wake", () => {
    const id = randomUUID();
    expect(readInteractionPendingWakeCardId({ reason: "interaction_pending", contextSnapshot: { interactionId: id } })).toBe(id);
    expect(readInteractionPendingWakeCardId({ contextSnapshot: { wakeReason: "interaction_pending" }, payload: { interactionId: id } })).toBe(id);
    expect(readInteractionPendingWakeCardId({ reason: "issue_assigned", contextSnapshot: { interactionId: id } })).toBeNull();
    expect(readInteractionPendingWakeCardId({ reason: "interaction_pending", contextSnapshot: { interactionId: "nope" } })).toBeNull();
  });

  it("uses 50 by default and the heartbeat value when set", () => {
    expect(resolveInteractionWakeBypassCap({})).toBe(DEFAULT_MAX_DAILY_INTERACTION_WAKE_RUNS);
    expect(DEFAULT_MAX_DAILY_INTERACTION_WAKE_RUNS).toBe(50);
    expect(resolveInteractionWakeBypassCap({ maxDailyInteractionWakes: 3 })).toBe(3);
    expect(resolveInteractionWakeBypassCap({ maxDailyInteractionWakes: -1 })).toBe(50);
  });
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedSupport.supported ? describe : describe.skip;

describeEmbedded("interaction wakes and the daily run limit", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-interaction-wake-limit-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(heartbeatConfig: Record<string, unknown> = { maxDailyRuns: 1 }) {
    const companyId = randomUUID();
    const addresseeId = randomUUID();
    const askerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "interaction-wakes",
      defaultResponsibleUserId: "responsible-user",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const base = {
      companyId,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
    };
    await db.insert(agents).values([
      {
        ...base,
        id: addresseeId,
        name: "operator",
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, ...heartbeatConfig } },
      },
      { ...base, id: askerId, name: "engineer", runtimeConfig: {} },
    ]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Engineer waits for the operator",
      status: "in_review",
      priority: "high",
      assigneeAgentId: askerId,
    });
    return { companyId, addresseeId, askerId, issueId };
  }

  async function seedCard(input: {
    companyId: string;
    issueId: string;
    addresseeId: string;
    createdAt?: Date;
    status?: string;
  }) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: input.status ?? "pending",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: input.addresseeId,
      title: "Confirm the plan",
      payload: { version: 1, prompt: "Confirm?", supersedeOnUserComment: true },
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return id;
  }

  async function useUpDailyLimit(companyId: string, agentId: string, runs = 1) {
    const now = new Date();
    for (let i = 0; i < runs; i += 1) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        contextSnapshot: { wakeReason: "idle_pickup" },
        resultJson: {},
      });
    }
  }

  function wakeFor(input: { issueId: string; cardId: string }) {
    return {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "interaction_pending",
      payload: { issueId: input.issueId, interactionId: input.cardId, interactionKind: "request_confirmation", mutation: "interaction" },
      idempotencyKey: `interaction-pending:${input.cardId}`,
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        interactionId: input.cardId,
        wakeReason: "interaction_pending",
        source: "issue.interaction.created",
      },
    };
  }

  async function receiptsOf(agentId: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  }

  it("lets an interaction_pending wake through when the daily run limit is used up", async () => {
    const { companyId, addresseeId, issueId } = await seed({ maxDailyRuns: 1 });
    await useUpDailyLimit(companyId, addresseeId);
    const cardId = await seedCard({ companyId, issueId, addresseeId });

    await heartbeat.wakeup(addresseeId, wakeFor({ issueId, cardId }));

    const receipts = await receiptsOf(addresseeId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reason).not.toBe("heartbeat.daily_run_limit");
    expect(receipts[0]?.status).not.toBe("skipped");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, addresseeId));
    expect(runs.some((run) => (run.contextSnapshot as Record<string, unknown>).interactionId === cardId)).toBe(true);
  });

  it("still refuses the same wake at the limit when the card is not pending for this agent", async () => {
    const { companyId, addresseeId, askerId, issueId } = await seed({ maxDailyRuns: 1 });
    await useUpDailyLimit(companyId, addresseeId);
    const answered = await seedCard({ companyId, issueId, addresseeId, status: "answered" });
    const otherAddressee = await seedCard({ companyId, issueId, addresseeId: askerId });

    await heartbeat.wakeup(addresseeId, wakeFor({ issueId, cardId: answered }));
    await heartbeat.wakeup(addresseeId, wakeFor({ issueId, cardId: otherAddressee }));

    const receipts = await receiptsOf(addresseeId);
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ status: "skipped", reason: "heartbeat.daily_run_limit" });
    }
  });

  it("stops bypassing once the per-day interaction wake cap is used", async () => {
    const { companyId, addresseeId, askerId, issueId } = await seed({ maxDailyRuns: 1, maxDailyInteractionWakes: 1 });
    await useUpDailyLimit(companyId, addresseeId);
    // A second task: a wake on the task the first run holds would be parked, not refused.
    const secondIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondIssueId,
      companyId,
      title: "Another engineer waits",
      status: "in_review",
      priority: "high",
      assigneeAgentId: askerId,
    });
    const first = await seedCard({ companyId, issueId, addresseeId });
    const second = await seedCard({ companyId, issueId: secondIssueId, addresseeId });

    await heartbeat.wakeup(addresseeId, wakeFor({ issueId, cardId: first }));
    await heartbeat.wakeup(addresseeId, wakeFor({ issueId: secondIssueId, cardId: second }));

    const receipts = await receiptsOf(addresseeId);
    const byCard = (cardId: string) =>
      receipts.find((receipt) => (receipt.payload as Record<string, unknown>)?.interactionId === cardId);
    expect(byCard(first)?.status).not.toBe("skipped");
    expect(byCard(second)).toMatchObject({ status: "skipped", reason: "heartbeat.daily_run_limit" });
  });

  describe("stale card sweep", () => {
    function makeSweep(woken: StaleInteractionRewake[], companyId: string) {
      return createStaleInteractionRewakeSweep({
        db,
        // The stand-in records the receipt the real admission would write, so the
        // second pass sees the first wake the way it does in production.
        rewake: async (wake) => {
          // The database is shared by the cases of this file: count only this case.
          if (wake.companyId === companyId) woken.push(wake);
          await db.insert(agentWakeupRequests).values({
            companyId: wake.companyId,
            agentId: wake.agentId,
            source: "automation",
            triggerDetail: "system",
            reason: "interaction_pending",
            status: "skipped",
            payload: wake.payload,
            idempotencyKey: wake.idempotencyKey,
          });
        },
      });
    }

    it("wakes the addressee of a stale pending card and does not wake again within 30 minutes", async () => {
      const { companyId, addresseeId, issueId } = await seed();
      const now = new Date();
      const cardId = await seedCard({
        companyId,
        issueId,
        addresseeId,
        createdAt: new Date(now.getTime() - 40 * 60_000),
      });
      const woken: StaleInteractionRewake[] = [];
      const sweep = makeSweep(woken, companyId);

      await sweep({ now });
      expect(woken).toHaveLength(1);
      expect(woken[0]).toMatchObject({
        agentId: addresseeId,
        interactionId: cardId,
        contextSnapshot: { wakeReason: "interaction_pending", source: "issue.interaction.created", interactionId: cardId },
      });

      await sweep({ now: new Date(now.getTime() + 10 * 60_000) });
      expect(woken).toHaveLength(1);

      await sweep({ now: new Date(Date.now() + STALE_INTERACTION_WAKE_MS + 60_000) });
      expect(woken).toHaveLength(2);
    });

    it("leaves alone a young card, a card with a live addressee run, and an answered card", async () => {
      const { companyId, addresseeId, issueId } = await seed();
      const now = new Date();
      const old = new Date(now.getTime() - 40 * 60_000);
      await seedCard({ companyId, issueId, addresseeId, createdAt: new Date(now.getTime() - 5 * 60_000) });
      await seedCard({ companyId, issueId, addresseeId, createdAt: old, status: "answered" });
      const liveCard = await seedCard({ companyId, issueId, addresseeId, createdAt: old });
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: addresseeId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        startedAt: now,
        contextSnapshot: { issueId, interactionId: liveCard },
      });
      const woken: StaleInteractionRewake[] = [];

      await makeSweep(woken, companyId)({ now });

      expect(woken).toHaveLength(0);
    });
  });
});
