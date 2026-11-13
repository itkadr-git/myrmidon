import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "./postgres.js";
import { queuedRunWaitedAtLeastSql } from "./queued-run-age.js";

// P2: the wake of a pending interaction's addressee survives an assignee that is someone else.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("run-dispatch: pending interaction addressee wake (P2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-addressee-wake-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { interactionStatus?: string; addressee?: "reviewer" | "assignee" } = {}) {
    const companyId = randomUUID();
    const assigneeId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "user-a",
    });
    for (const [id, name] of [
      [assigneeId, "agent-a"],
      [reviewerId, "agent-b"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task that asks another agent for confirmation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: assigneeId,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: input.interactionStatus ?? "pending",
      addresseeAgentId: (input.addressee ?? "reviewer") === "reviewer" ? reviewerId : assigneeId,
      payload: { version: 1, prompt: "Approve the release notes?" },
    });
    return { companyId, assigneeId, reviewerId, issueId, interactionId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    contextSnapshot: Record<string, unknown>;
    invocationSource?: "automation" | "on_demand";
    createdAt?: Date;
    scheduledRetryAt?: Date | null;
    scheduledRetryAttempt?: number;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "automation",
      status: "queued",
      contextSnapshot: input.contextSnapshot,
      createdAt: input.createdAt,
      scheduledRetryAt: input.scheduledRetryAt ?? null,
      scheduledRetryAttempt: input.scheduledRetryAttempt,
    });
    return runId;
  }

  function addresseeWakeContext(issueId: string, interactionId: string) {
    return {
      issueId,
      taskId: issueId,
      interactionId,
      interactionKind: "request_confirmation",
      wakeReason: "interaction_pending",
      source: "issue.interaction.created",
    };
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
  }

  it("keeps the queued run of a non-assignee addressee of a pending interaction", async () => {
    const { companyId, reviewerId, issueId, interactionId } = await seed();
    const runId = await seedRun({
      companyId,
      agentId: reviewerId,
      contextSnapshot: addresseeWakeContext(issueId, interactionId),
    });

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome.outcome).toBe("not_stale");
    expect(await runStatus(runId)).toEqual({ status: "queued", errorCode: null });
  });

  it("keeps a productive continuation recovery queued after the issue is reassigned", async () => {
    const { companyId, assigneeId, reviewerId, issueId } = await seed();
    await db.update(issues).set({ assigneeAgentId: reviewerId }).where(eq(issues.id, issueId));
    const runId = await seedRun({
      companyId,
      agentId: assigneeId,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.productive_terminal_continuation_recovery",
      },
    });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.invocationSource).toBe("automation");
    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome.outcome).toBe("not_stale");
    expect(await runStatus(runId)).toEqual({ status: "queued", errorCode: null });
  });

  it("does not let a non-automation invocation use productive recovery ownership", async () => {
    const { companyId, reviewerId, issueId } = await seed();
    const runId = await seedRun({
      companyId,
      agentId: reviewerId,
      invocationSource: "on_demand",
      contextSnapshot: {
        issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.productive_terminal_continuation_recovery",
      },
    });

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId, companyId, expectedStatus: "queued", now: new Date(),
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_assignee_changed" });
  });

  it("still cancels an ordinary wake of a non-assignee as issue_assignee_changed", async () => {
    const { companyId, reviewerId, issueId } = await seed();
    const runId = await seedRun({
      companyId,
      agentId: reviewerId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_assignee_changed" });
  });

  it("cancels the addressee wake once the interaction is no longer pending", async () => {
    const { companyId, reviewerId, issueId, interactionId } = await seed({ interactionStatus: "accepted" });
    const runId = await seedRun({
      companyId,
      agentId: reviewerId,
      contextSnapshot: addresseeWakeContext(issueId, interactionId),
    });

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_assignee_changed" });
  });

  it("appends activity_log and releases issue executionRunId for expired queued runs", async () => {
    const { companyId, assigneeId, issueId } = await seed();
    const runId = await seedRun({ companyId, agentId: assigneeId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - 31 * 60 * 1000) }).where(eq(heartbeatRuns.id, runId));
    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId, companyId, expectedStatus: "queued", staleAfterMs: 30 * 60 * 1000, now: new Date(),
    });
    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    const rows = await db.select().from(activityLog).where(eq(activityLog.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "heartbeat_run.cancelled", entityId: runId });
    const [issue] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.executionRunId).toBeNull();
  });

  // myrmidon(OPE-11947): a scheduled retry is created at the failure and enters
  // the queue when `scheduled_retry_at` falls due (30 min, 1 h, 2 h, 4 h, 6 h for
  // a model-unavailable wait). Its age as a queued run counts from that moment,
  // not from `created_at`; otherwise every promoted retry was cancelled on
  // arrival and the chain restarted from attempt 0.
  describe("stale age of a promoted scheduled retry (OPE-11947)", () => {
    const MIN = 60 * 1000;
    const staleAfterMs = 30 * MIN;

    async function seedAgedRun(input: { createdMinAgo: number; dueMinAgo: number | null }) {
      const { companyId, assigneeId, issueId } = await seed();
      const now = new Date();
      const runId = await seedRun({
        companyId,
        agentId: assigneeId,
        contextSnapshot: { issueId },
        createdAt: new Date(now.getTime() - input.createdMinAgo * MIN),
        scheduledRetryAt: input.dueMinAgo === null ? null : new Date(now.getTime() - input.dueMinAgo * MIN),
        scheduledRetryAttempt: input.dueMinAgo === null ? undefined : 1,
      });
      return { companyId, runId, now };
    }

    async function listedAsStale(runId: string, now: Date) {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "queued"), queuedRunWaitedAtLeastSql(now, staleAfterMs)));
      return rows.length === 1;
    }

    it("keeps a retry that became queued a minute ago although it was created 40 minutes ago", async () => {
      const { companyId, runId, now } = await seedAgedRun({ createdMinAgo: 40, dueMinAgo: 1 });

      expect(await listedAsStale(runId, now)).toBe(false);
      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", staleAfterMs, now,
      });
      expect(outcome.outcome).toBe("not_stale");
      expect(await runStatus(runId)).toMatchObject({ status: "queued", errorCode: null });
    });

    it("keeps a retry with a long delay that was created hours ago and fell due a minute ago", async () => {
      const { companyId, runId, now } = await seedAgedRun({ createdMinAgo: 6 * 60 + 1, dueMinAgo: 1 });

      expect(await listedAsStale(runId, now)).toBe(false);
      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", staleAfterMs, now,
      });
      expect(outcome.outcome).toBe("not_stale");
    });

    it("still cancels an ordinary queued run (no scheduled_retry_at) created 40 minutes ago", async () => {
      const { companyId, runId, now } = await seedAgedRun({ createdMinAgo: 40, dueMinAgo: null });

      expect(await listedAsStale(runId, now)).toBe(true);
      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", staleAfterMs, now,
      });
      expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
      expect(await runStatus(runId)).toMatchObject({ status: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("cancels a retry that has stood in the queue longer than the threshold since it fell due", async () => {
      const { companyId, runId, now } = await seedAgedRun({ createdMinAgo: 90, dueMinAgo: 31 });

      expect(await listedAsStale(runId, now)).toBe(true);
      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", staleAfterMs, now,
      });
      expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
      expect(await runStatus(runId)).toMatchObject({ status: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("counts a not-yet-due scheduled_retry_at as no due time: the age falls back to created_at", async () => {
      const { companyId, runId, now } = await seedAgedRun({ createdMinAgo: 40, dueMinAgo: -5 });

      expect(await listedAsStale(runId, now)).toBe(true);
      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", staleAfterMs, now,
      });
      expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });
  });

  it("does not let another agent borrow the addressee wake context", async () => {
    const { companyId, assigneeId, issueId, interactionId } = await seed();
    const outsiderId = randomUUID();
    await db.insert(agents).values({
      id: outsiderId,
      companyId,
      name: "agent-c",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    expect(assigneeId).not.toBe(outsiderId);
    const runId = await seedRun({
      companyId,
      agentId: outsiderId,
      contextSnapshot: addresseeWakeContext(issueId, interactionId),
    });

    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });

    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_assignee_changed" });
  });

  // myrmidon(OPE-11948): a queued automatic continuation dies when the issue was
  // parked or sent to review after the wake was created.
  describe("automatic continuation wake (OPE-11948)", () => {
    function continuationContext(issueId: string, extra: Record<string, unknown> = {}) {
      return {
        issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
        ...extra,
      };
    }

    it.each(["blocked", "in_review"])("cancels the queued run when the issue is %s", async (status) => {
      const { companyId, assigneeId, issueId } = await seed();
      await db.update(issues).set({ status }).where(eq(issues.id, issueId));
      const runId = await seedRun({ companyId, agentId: assigneeId, contextSnapshot: continuationContext(issueId) });

      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", now: new Date(),
      });

      expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "issue_not_in_progress" });
      expect((await runStatus(runId))?.status).toBe("cancelled");
    });

    it.each(["todo", "in_progress"])("keeps the queued run while the issue is %s", async (status) => {
      const { companyId, assigneeId, issueId } = await seed();
      await db.update(issues).set({ status }).where(eq(issues.id, issueId));
      const runId = await seedRun({ companyId, agentId: assigneeId, contextSnapshot: continuationContext(issueId) });

      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", now: new Date(),
      });

      expect(outcome.outcome).toBe("not_stale");
      expect(await runStatus(runId)).toEqual({ status: "queued", errorCode: null });
    });

    it("keeps a continuation that answers a resolved interaction card queued while the issue waits in review", async () => {
      const { companyId, assigneeId, issueId, interactionId } = await seed({ interactionStatus: "accepted", addressee: "assignee" });
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
      const runId = await seedRun({
        companyId,
        agentId: assigneeId,
        contextSnapshot: continuationContext(issueId, {
          mutation: "interaction",
          interactionId,
          interactionStatus: "accepted",
          interactionResolvedAt: new Date().toISOString(),
        }),
      });

      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", now: new Date(),
      });

      expect(outcome.outcome).toBe("not_stale");
    });

    it("keeps an explicit resume of a blocked issue queued", async () => {
      const { companyId, assigneeId, issueId } = await seed();
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      const runId = await seedRun({
        companyId,
        agentId: assigneeId,
        contextSnapshot: continuationContext(issueId, { resumeIntent: true }),
      });

      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", now: new Date(),
      });

      expect(outcome.outcome).toBe("not_stale");
    });
  });
});
