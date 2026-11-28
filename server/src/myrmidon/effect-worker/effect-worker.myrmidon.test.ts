/**
 * OPE-12798: effect-worker layer tests.
 *
 * Test discipline (t3code AGENTS.md G, INV-15): every test drains the worker
 * explicitly and waits for concrete persisted milestones — never `sleep`.
 * The helpers (`drainEffects`, `drainEffectsUntilIdle`, `waitForEffectMilestone`)
 * live in `test-helpers.ts` and are the only waiting primitives allowed in
 * this directory.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  companies,
  createDb,
  agents,
  heartbeatRuns,
  heartbeatRunEvents,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createEffectWorker, EFFECT_WORKER_KEY_PREFIX } from "./effect-worker.js";
import {
  drainEffects,
  drainEffectsUntilIdle,
  waitForEffectMilestone,
} from "./test-helpers.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("effect worker", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-effect-worker-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (tempDb) await tempDb.cleanup();
  });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "FX Co" }).returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: "fx-agent", adapterType: "claude" })
      .returning();
    return { company: company!, agent: agent! };
  }

  async function enqueueEffect(
    seeded: { company: { id: string }; agent: { id: string } },
    kind: string,
    payload: Record<string, unknown>,
  ) {
    const key = `${EFFECT_WORKER_KEY_PREFIX}${kind}:${crypto.randomUUID()}`;
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.company.id,
      agentId: seeded.agent.id,
      source: "automation",
      triggerDetail: "system",
      reason: "test_effect",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "effect-worker",
      idempotencyKey: key,
      payload: { effectKind: kind, ...payload },
    });
    return key;
  }

  it("drains a registered effect and records the result as an intent milestone", async () => {
    const seeded = await seed();
    const worker = createEffectWorker(db);
    const handler = vi.fn(async (ctx: { recordMilestone: (m: Record<string, unknown>) => Promise<void> }) => {
      await ctx.recordMilestone({ progress: "half" });
      return { outcome: "settled" as const, result: { value: 42 } };
    });
    worker.registerEffect("test-kind", handler);

    const key = await enqueueEffect(seeded, "test-kind", { input: "hello" });
    const result = await drainEffects(worker);

    expect(result.settled).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);

    // Result-as-command: the milestone is persisted on the intent row.
    const milestone = await waitForEffectMilestone(db, key, (effect) => effect.outcome === "settled");
    expect(milestone.kind).toBe("test-kind");
    expect(milestone.outcome).toBe("settled");
    expect(milestone.result).toMatchObject({ value: 42 });
    expect(milestone.finishedAt).toBeTruthy();

    // The intent row is terminal (coalesced = settled in effect-worker terms).
    const rows = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, key));
    expect(rows[0]?.status).toBe("coalesced");
  });

  it("keeps the intent queued when the handler requests release", async () => {
    const seeded = await seed();
    const worker = createEffectWorker(db);
    worker.registerEffect("release-kind", async () => ({ outcome: "released" as const }));

    const key = await enqueueEffect(seeded, "release-kind", {});
    const result = await drainEffects(worker);

    expect(result.released).toBe(1);
    const rows = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, key));
    expect(rows[0]?.status).toBe("queued");
  });

  it("marks skipped outcomes terminal on the intent row", async () => {
    const seeded = await seed();
    const worker = createEffectWorker(db);
    worker.registerEffect("skip-kind", async () => ({
      outcome: "skipped" as const,
      error: "nothing_to_do",
    }));

    const key = await enqueueEffect(seeded, "skip-kind", {});
    const result = await drainEffects(worker);

    expect(result.skipped).toBe(1);
    const rows = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, key));
    expect(rows[0]?.status).toBe("skipped");
    expect(rows[0]?.error).toBe("nothing_to_do");
  });

  it("releases the claim when the handler throws so the next drain can retry", async () => {
    const seeded = await seed();
    const worker = createEffectWorker(db);
    let attempts = 0;
    worker.registerEffect("flaky-kind", async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient");
      return { outcome: "settled" as const };
    });

    const key = await enqueueEffect(seeded, "flaky-kind", {});
    const first = await drainEffects(worker);
    expect(first.failed).toBe(1);

    // Second drain: the claim was released after failure, so the handler runs again.
    const second = await drainEffects(worker);
    expect(second.failed).toBe(1);

    const third = await drainEffects(worker);
    expect(third.settled).toBe(1);
    expect(attempts).toBe(3);

    const milestone = await waitForEffectMilestone(db, key, (effect) => effect.outcome === "settled");
    expect(milestone.outcome).toBe("settled");
  });

  it("drainEffectsUntilIdle drains until no more work remains", async () => {
    const seeded = await seed();
    const worker = createEffectWorker(db);
    let calls = 0;
    worker.registerEffect("chain-kind", async () => {
      calls += 1;
      if (calls < 3) {
        // Enqueue a follow-up effect from inside the handler.
        await enqueueEffect(seeded, "chain-kind", { iteration: calls });
      }
      return { outcome: "settled" as const };
    });

    await enqueueEffect(seeded, "chain-kind", { iteration: 0 });
    const result = await drainEffectsUntilIdle(worker);

    expect(calls).toBe(3);
    expect(result.settled).toBe(1); // last drain settled the final effect
  });

  it("appends a run event when the handler explicitly records one", async () => {
    const seeded = await seed();
    const worker = createEffectWorker(db);
    // Create a real heartbeat run so appendHeartbeatRunEvent succeeds.
    const fakeRunId = crypto.randomUUID();
    await db.insert(heartbeatRuns).values({
      id: fakeRunId,
      companyId: seeded.company.id,
      agentId: seeded.agent.id,
      invocationSource: "automation",
      status: "succeeded",
      contextSnapshot: {},
    });
    worker.registerEffect("run-event-kind", async (ctx) => {
      await ctx.appendRunEvent(fakeRunId, {
        eventType: "effect_result",
        message: "test effect completed",
        payload: { custom: "data" },
      });
      return { outcome: "settled" as const, runId: fakeRunId };
    });

    const key = await enqueueEffect(seeded, "run-event-kind", {});
    const result = await drainEffects(worker);
    expect(result.settled).toBe(1);

    // The intent row now carries the runId.
    const rows = await db
      .select({ runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, key));
    expect(rows[0]?.runId).toBe(fakeRunId);

    // The run event was persisted.
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, fakeRunId));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.eventType).toBe("effect_result");
  });
});
