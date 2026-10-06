// myrmidon(1.6-AUTONOMY): the acceptance criteria against an embedded Postgres.
//
// This is the end-to-end half of the feature: the real gate writes the hold, the
// real review transaction decides it, and the real executor pauses the target
// agent. It proves the two criteria the unit suite can only model —
// "after approval the target agent is paused" and "a double approval does not
// run the action twice" — against real SQL, real NOT NULL constraints and a real
// activity log.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  instanceSettings,
  toolActionRequests,
  toolInvocations,
} from "@paperclipai/db";
import { defaultAutonomyMatrix } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { decideHeldAutonomyAction } from "./action-decision.js";
import { dbAutonomyGate } from "./gate.js";
import { AUTONOMY_GENERAL_KEY } from "./store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ENGINEER = "engineer";

describeEmbeddedPostgres("myrmidon(1.6-AUTONOMY) held action decision", () => {
  vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-autonomy-action-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-engineer",
      role: ENGINEER,
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  /** Write the matrix the way the settings API does: our key of general. */
  async function seedMatrix(verdict: "allowed" | "approval_required" | "forbidden") {
    const matrix = defaultAutonomyMatrix();
    const general = {
      [AUTONOMY_GENERAL_KEY]: {
        version: 1,
        matrix: {
          ...matrix,
          rules: [{ role: ENGINEER, actionClass: "pause_wake_agents", verdict }],
        },
        regulations: [],
      },
    };
    // The image may already carry the singleton settings row; the store writes
    // this key with jsonb_set, so an upsert is what production does too.
    await db
      .insert(instanceSettings)
      .values({ singletonKey: "default", general, experimental: {} })
      .onConflictDoUpdate({
        target: instanceSettings.singletonKey,
        set: { general, updatedAt: new Date() },
      });
  }

  /** The caller the routes present to the gate. */
  function agentRequest(companyId: string, agentId: string) {
    return { actor: { type: "agent", agentId, companyId } } as unknown as Parameters<
      ReturnType<typeof dbAutonomyGate>["holdOrAssert"]
    >[0];
  }

  async function holdPause(companyId: string, agentId: string) {
    const gate = dbAutonomyGate(db);
    const held = await gate.holdOrAssert(agentRequest(companyId, agentId), "pause_wake_agents", {
      route: `/agents/${agentId}/pause`,
      method: "POST",
    });
    if (!("approvalId" in held)) throw new Error(`expected a held action, got ${held.verdict}`);
    return held.approvalId;
  }

  async function statusOf(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row;
  }

  async function executionLogCount() {
    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "myrmidon.autonomy.action_executed"));
    return rows.length;
  }

  it("holds the pause, then pauses the target agent exactly once on approval", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedMatrix("approval_required");

    const approvalId = await holdPause(companyId, agentId);

    // The hold itself runs nothing: the agent is still idle and a card exists.
    expect((await statusOf(agentId)).status).toBe("idle");
    const [heldRequest] = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, approvalId));
    expect(heldRequest.status).toBe("pending");
    const [heldInvocation] = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.id, heldRequest.invocationId));
    expect(heldInvocation.toolName).toBe("autonomy_action_pause_wake_agents");
    expect(heldInvocation.status).toBe("awaiting_approval");
    expect(heldInvocation.argumentsHash).toMatch(/^[0-9a-f]{64}$/);

    const decided = await decideHeldAutonomyAction({
      db,
      companyId,
      actionRequestId: approvalId,
      decision: "approved",
      actor: { userId: "user-1" },
    });
    expect(decided).toEqual({ kind: "decided", status: "executed" });

    // After the approval the target agent is paused, and both rows are settled.
    const settledAgent = await statusOf(agentId);
    expect(settledAgent.status).toBe("paused");
    expect(settledAgent.pauseReason).toBe("manual");
    const [request] = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, approvalId));
    expect(request.status).toBe("executed");
    expect(request.decidedByUserId).toBe("user-1");
    const [invocation] = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.id, request.invocationId));
    expect(invocation.status).toBe("succeeded");
    expect(invocation.approvalState).toBe("approved");
    expect(await executionLogCount()).toBe(1);
  });

  it("never runs the action twice on a repeated approval", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedMatrix("approval_required");
    const approvalId = await holdPause(companyId, agentId);

    const approve = () =>
      decideHeldAutonomyAction({
        db,
        companyId,
        actionRequestId: approvalId,
        decision: "approved",
        actor: { userId: "user-1" },
      });
    await approve();
    const pausedAt = (await statusOf(agentId)).pausedAt;
    const second = await approve();

    // The second approval finds the settled row and replays nothing.
    expect(second).toEqual({ kind: "decided", status: "executed" });
    expect(await executionLogCount()).toBe(1);
    expect((await statusOf(agentId)).pausedAt?.getTime()).toBe(pausedAt?.getTime());
    const [request] = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, approvalId));
    expect(request.status).toBe("executed");
  });

  it("does not run the action when the card is rejected", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedMatrix("approval_required");
    const approvalId = await holdPause(companyId, agentId);

    const decided = await decideHeldAutonomyAction({
      db,
      companyId,
      actionRequestId: approvalId,
      decision: "rejected",
      actor: { userId: "user-1" },
      reason: "not now",
    });
    expect(decided).toEqual({ kind: "decided", status: "rejected" });

    expect((await statusOf(agentId)).status).toBe("idle");
    const [request] = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, approvalId));
    expect(request.status).toBe("rejected");
    const [invocation] = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.id, request.invocationId));
    expect(invocation.status).toBe("denied");
    expect(await executionLogCount()).toBe(0);
  });

  it("does not hold an allowed action", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedMatrix("allowed");

    const gate = dbAutonomyGate(db);
    const decision = await gate.holdOrAssert(
      agentRequest(companyId, agentId),
      "pause_wake_agents",
      { route: `/agents/${agentId}/pause`, method: "POST" },
    );

    expect(decision).toEqual({ verdict: "allowed", held: false });
    expect(await db.select().from(toolActionRequests)).toHaveLength(0);
  });
});