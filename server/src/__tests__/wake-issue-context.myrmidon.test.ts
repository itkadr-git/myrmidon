// myrmidon(N4-WAKE-ISSUE-CONTEXT): a wake whose task id reaches
// enqueueWakeup only via contextSnapshot.issueId must still be stored and
// delivered with that id — the wake carries its task context. This is the
// wake-side half of N4: heartbeatService.wakeup is the single entry point, so
// the backfill lives in one place and every caller (routes, outbox, idle
// pickup, run-stall sweep) gets it for free.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

describe("wakeup task context (myrmidon N4-WAKE-ISSUE-CONTEXT)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("wake-issue-context-");
    db = createDb(temporary.connectionString);
    registerServerAdapter({
      type: "wake_context_test",
      execute: vi.fn(async () => {
        throw new Error("wake_context_test adapter not implemented");
      }),
      testEnvironment: async () => ({
        adapterType: "wake_context_test",
        status: "pass" as const,
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });
  }, 30_000);

  afterAll(async () => {
    unregisterServerAdapter("wake_context_test");
    await temporary.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Wake context co",
      issuePrefix: `WC${companyId.slice(0, 5)}`,
      defaultResponsibleUserId: "board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "wake-context-agent",
      role: "engineer",
      status: "idle",
      adapterType: "wake_context_test",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wake context task",
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: "board-user",
    });
    const heartbeat = heartbeatService(db);
    return { companyId, agentId, issueId, heartbeat };
  }

  async function drain(heartbeat: ReturnType<typeof heartbeatService>) {
    // The wake dispatches a run fire-and-forget; the process adapter fails in
    // this environment, and the failure unwinds through a shared db handle.
    // Awaiting the in-flight execution here keeps that noise inside the test
    // and leaves a settled database for the receipt reads below.
    await heartbeat.drainActiveRunExecutions().catch(() => undefined);
  }

  async function wakeReceipt(agentId: string, reason: string) {
    const receipts = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    // A successful wake queues one request; a follow-up retry may add more.
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    const receipt = receipts.find((r) => r.reason === reason) ?? receipts[0]!;
    return receipt;
  }

  it("stores a wake with only contextSnapshot.issueId with that issueId in the payload", async () => {
    const { agentId, issueId, heartbeat } = await fixture();

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_stalled_run",
      contextSnapshot: { issueId, reason: "run_stalled", wakePolicy: "n4-test" },
    });
    await drain(heartbeat);

    expect(run?.status).toBe("queued");
    const receipt = await wakeReceipt(agentId, "issue_stalled_run");
    expect(receipt.payload).toMatchObject({ issueId });
  });

  it("keeps an explicit payload.issueId when both are present", async () => {
    const { agentId, issueId: payloadIssue, heartbeat } = await fixture();

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId: payloadIssue },
      contextSnapshot: { issueId: payloadIssue },
    });
    await drain(heartbeat);

    expect(run?.status).toBe("queued");
    const receipt = await wakeReceipt(agentId, "issue_commented");
    expect(receipt.payload).toMatchObject({ issueId: payloadIssue });
  });

  it("a wake with no task context at all keeps its payload without an issueId", async () => {
    const { agentId, heartbeat } = await fixture();

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "on_demand",
    });
    await drain(heartbeat);

    expect(run?.status).toBe("queued");
    const receipt = await wakeReceipt(agentId, "on_demand");
    expect(receipt.payload?.issueId).toBeUndefined();
  });
});
