// myrmidon(OPE-8268 WAKE-STALL C): a deferred wake must not outlive its lock.
// The reconcile pass (a) cancels deferred wakes of closed tasks, (b) hands the
// queue of an open task with a free lock to the ordinary release drain, also
// for wakes without comment ids and after an acknowledged operator Stop that
// predates them, and (c) leaves a task under an effective "do not replay" hold
// alone. It is idempotent, so the first pass after deploy is the one-off cleanup.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stranded deferred wake reconcile test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded deferred wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stranded deferred wake reconcile (OPE-8268)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  const companyId = randomUUID();
  const agentId = randomUUID();
  const HOUR = 3_600_000;
  const longAgo = () => new Date(Date.now() - 6 * HOUR);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-deferred-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 20_000);

  beforeEach(async () => {
    await db.insert(companies).values({
      id: companyId,
      name: "Stranded Wake Test Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
    });
  });

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Promotion writes runs, events and activity rows; truncating from the
    // company cascades through every dependent table.
    await db.execute(sql`truncate table companies cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let issueSeq = 0;
  async function seedIssue(status: string, extra: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    issueSeq += 1;
    await db.insert(issues).values({
      id,
      companyId,
      title: `Stranded wake issue ${issueSeq}`,
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: issueSeq,
      identifier: `STR-${issueSeq}`,
      ...extra,
    });
    return id;
  }

  async function seedFinishedRun(issueId: string, extra: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const id = randomUUID();
    const finishedAt = new Date(Date.now() - 8 * HOUR);
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      startedAt: new Date(finishedAt.getTime() - 60_000),
      finishedAt,
      createdAt: new Date(finishedAt.getTime() - 60_000),
      contextSnapshot: { issueId, taskId: issueId },
      ...extra,
    });
    return id;
  }

  async function seedDeferredWake(issueId: string, extra: Partial<typeof agentWakeupRequests.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId,
      agentId,
      source: "automation",
      reason: "issue_assigned",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedAt: longAgo(),
      updatedAt: longAgo(),
      ...extra,
    });
    return id;
  }

  async function wakeRow(id: string) {
    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id));
    return row!;
  }

  it("cancels deferred wakes of a closed task whose lock is free, with the close marker", async () => {
    const done = await seedIssue("done");
    const cancelled = await seedIssue("cancelled");
    const wakeDone = await seedDeferredWake(done, { reason: "issue_commented", requestedByActorType: "user" });
    const wakeCancelled = await seedDeferredWake(cancelled);

    const result = await heartbeat.reconcileStrandedDeferredWakes();

    expect(result.cancelledTerminal).toBe(2);
    for (const id of [wakeDone, wakeCancelled]) {
      const row = await wakeRow(id);
      expect(row.status).toBe("cancelled");
      expect(row.error).toBe("issue_closed");
      expect(row.finishedAt).not.toBeNull();
    }
  });

  it("leaves a closed task's wake alone while a run still holds the lock, and a wake too fresh to judge", async () => {
    const heldRunId = randomUUID();
    const held = await seedIssue("done");
    await db.insert(heartbeatRuns).values({
      id: heldRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "running", contextSnapshot: { issueId: held },
    });
    await db.update(issues).set({ executionRunId: heldRunId }).where(eq(issues.id, held));
    const wakeHeld = await seedDeferredWake(held);

    const fresh = await seedIssue("done");
    const wakeFresh = await seedDeferredWake(fresh, { requestedAt: new Date(), updatedAt: new Date() });

    await heartbeat.reconcileStrandedDeferredWakes();

    expect((await wakeRow(wakeHeld)).status).toBe("deferred_issue_execution");
    expect((await wakeRow(wakeFresh)).status).toBe("deferred_issue_execution");
  });

  it("promotes a deferred wake when its native run has no interaction metadata", async () => {
    const issueId = await seedIssue("todo");
    await seedFinishedRun(issueId, { contextSnapshot: {}, nativeIssueId: issueId });
    const wakeId = await seedDeferredWake(issueId, {
      reason: "issue_reopened_via_comment",
      payload: { issueId },
    });

    const result = await heartbeat.reconcileStrandedDeferredWakes();

    expect(result.revisited).toBe(1);
    expect((await wakeRow(wakeId)).status).not.toBe("deferred_issue_execution");
    const promoted = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakeId));
    expect(promoted).toHaveLength(1);
  });

  it("promotes a deferred wake without comment ids on an open task whose lock is free", async () => {
    const issueId = await seedIssue("todo");
    await seedFinishedRun(issueId);
    const wakeId = await seedDeferredWake(issueId, {
      reason: "issue_execution_deferred",
      payload: { issueId, mutation: "swarm_matched" },
    });

    const result = await heartbeat.reconcileStrandedDeferredWakes();

    expect(result.revisited).toBe(1);
    const row = await wakeRow(wakeId);
    expect(row.status).not.toBe("deferred_issue_execution");
    const promoted = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakeId));
    expect(promoted).toHaveLength(1);
  });

  it("promotes a wake queued after an acknowledged operator Stop, but not work queued before it", async () => {
    const after = await seedIssue("todo");
    await seedFinishedRun(after, {
      status: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    const wakeAfter = await seedDeferredWake(after, {
      requestedAt: new Date(Date.now() - 2 * HOUR), updatedAt: new Date(Date.now() - 2 * HOUR),
    });

    const before = await seedIssue("todo");
    await seedFinishedRun(before, {
      status: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    const wakeBefore = await seedDeferredWake(before, {
      requestedAt: new Date(Date.now() - 12 * HOUR), updatedAt: new Date(Date.now() - 12 * HOUR),
    });

    await heartbeat.reconcileStrandedDeferredWakes();

    expect((await wakeRow(wakeAfter)).status).not.toBe("deferred_issue_execution");
    expect((await wakeRow(wakeBefore)).status).toBe("deferred_issue_execution");
  });

  it("keeps waiting behind an effective do-not-replay hold, then advances once the hold is cleared", async () => {
    const issueId = await seedIssue("todo");
    await seedFinishedRun(issueId);
    const wakeId = await seedDeferredWake(issueId, { reason: "issue_execution_deferred" });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      status: "resolved",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `fp-${randomUUID()}`,
      nextAction: "Review the stopped run.",
      evidence: { automaticRecovery: { replay: "blocked" } },
    }).returning();

    const held = await heartbeat.reconcileStrandedDeferredWakes();
    expect(held.revisited).toBe(0);
    expect((await wakeRow(wakeId)).status).toBe("deferred_issue_execution");

    await db.update(issueRecoveryActions).set({
      evidence: { automaticRecovery: { replay: "cleared" } },
    }).where(eq(issueRecoveryActions.id, action!.id));
    await db.update(agentWakeupRequests).set({ updatedAt: longAgo() }).where(eq(agentWakeupRequests.id, wakeId));

    const cleared = await heartbeat.reconcileStrandedDeferredWakes();
    expect(cleared.revisited).toBe(1);
    expect((await wakeRow(wakeId)).status).not.toBe("deferred_issue_execution");
  });

  it("is idempotent: a second pass changes nothing", async () => {
    const done = await seedIssue("done");
    await seedDeferredWake(done);

    const first = await heartbeat.reconcileStrandedDeferredWakes();
    const second = await heartbeat.reconcileStrandedDeferredWakes();

    expect(first.cancelledTerminal).toBe(1);
    expect(second).toEqual({ cancelledTerminal: 0, revisited: 0 });
  });
});
