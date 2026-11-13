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

  // myrmidon(RESUME-QUEUE-AGE): the pause of an agent is not time spent waiting for
  // a start. The resume stamps the queued runs (`queueWaitResumedAt`) and the age
  // counts from the stamp; both the sweep's selection (SQL) and the cancellation
  // check (TS) read it.
  describe("age of a run that stood in the queue during a pause (RESUME-QUEUE-AGE)", () => {
    const MIN = 60 * 1000;
    const staleAfterMs = 30 * MIN;

    async function seedPausedQueueRun(input: { resumedMinAgo: number | null; waitReason?: string }) {
      const { companyId, assigneeId, issueId } = await seed();
      const now = new Date();
      const runId = await seedRun({
        companyId,
        agentId: assigneeId,
        contextSnapshot: {
          issueId,
          waitReason: input.waitReason ?? "agent_concurrency",
          ...(input.resumedMinAgo === null
            ? {}
            : { queueWaitResumedAt: new Date(now.getTime() - input.resumedMinAgo * MIN).toISOString() }),
        },
        createdAt: new Date(now.getTime() - 63 * MIN),
      });
      return { companyId, agentId: assigneeId, runId, now };
    }

    async function listedAsStale(runId: string, now: Date) {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "queued"), queuedRunWaitedAtLeastSql(now, staleAfterMs)));
      return rows.length === 1;
    }

    const cancel = (companyId: string, runId: string, now: Date) =>
      createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", staleAfterMs, now,
      });

    it("does not list or cancel a 63-minute-old run right after the resume, with no run of the agent running", async () => {
      const { companyId, runId, now } = await seedPausedQueueRun({ resumedMinAgo: 0 });

      expect(await listedAsStale(runId, now)).toBe(false);
      expect((await cancel(companyId, runId, now)).outcome).toBe("not_stale");
      expect(await runStatus(runId)).toMatchObject({ status: "queued", errorCode: null });
    });

    it("keeps a second run that waits for the slot of the agent's first resumed run", async () => {
      const { companyId, agentId, runId, now } = await seedPausedQueueRun({ resumedMinAgo: 5 });
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId, agentId, invocationSource: "automation", status: "running",
        contextSnapshot: {}, startedAt: new Date(now.getTime() - 5 * MIN),
      });

      expect(await listedAsStale(runId, now)).toBe(false);
      expect((await cancel(companyId, runId, now)).outcome).toBe("not_stale");
    });

    it("still cancels a run whose slot has been free longer than the threshold since the resume", async () => {
      const { companyId, runId, now } = await seedPausedQueueRun({ resumedMinAgo: 31 });

      expect(await listedAsStale(runId, now)).toBe(true);
      expect(await cancel(companyId, runId, now)).toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("ignores a stamp that is in the future or is not a date", async () => {
      const future = await seedPausedQueueRun({ resumedMinAgo: -10 });
      expect(await listedAsStale(future.runId, future.now)).toBe(true);
      const { companyId, assigneeId, issueId } = await seed();
      const now = new Date();
      const runId = await seedRun({
        companyId, agentId: assigneeId, contextSnapshot: { issueId, queueWaitResumedAt: "not-a-date" },
        createdAt: new Date(now.getTime() - 63 * MIN),
      });
      expect(await listedAsStale(runId, now)).toBe(true);
      expect((await cancel(companyId, runId, now)).outcome).toBe("cancelled");
    });
  });

  // myrmidon(EMPTY-RUNS-6): a queued run that stands behind its own agent's
  // running runs is a queue, not a stale run. Expiring it by age queued the
  // same run behind the same ceiling again, and after the second expiry the
  // rewake throttle froze the task with "2 runs without progress" although no
  // run of it had started (13.11: seven tasks assigned to one engineer with two
  // slots; two high-priority tasks were frozen while the engineer was working).
  describe("a run standing in its own agent's queue is not expired by age (EMPTY-RUNS-6)", () => {
    const MIN = 60 * 1000;
    const staleAfterMs = 30 * MIN;
    const ownSlotWait = {
      waitReason: "agent_concurrency",
      waitDetail: { limit: 1, running: 1, limitSource: "board" },
    };

    /** A run queued 40 minutes ago, plus (optionally) another run of the assignee or of the second agent. */
    async function seedWaitingRun(input: {
      waitContext?: Record<string, unknown>;
      otherRun?: { agent: "same" | "other"; status: "running" | "succeeded" } | null;
      wakeReason?: string;
    }) {
      const { companyId, assigneeId, reviewerId, issueId } = await seed();
      const now = new Date();
      const runId = await seedRun({
        companyId,
        agentId: assigneeId,
        contextSnapshot: {
          issueId,
          ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}),
          ...(input.waitContext ?? {}),
        },
        createdAt: new Date(now.getTime() - 40 * MIN),
      });
      if (input.otherRun) {
        const startedAt = new Date(now.getTime() - 50 * MIN);
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId: input.otherRun.agent === "same" ? assigneeId : reviewerId,
          invocationSource: "automation",
          status: input.otherRun.status,
          contextSnapshot: {},
          createdAt: startedAt,
          startedAt,
          finishedAt: input.otherRun.status === "running" ? null : new Date(now.getTime() - 45 * MIN),
        });
      }
      return { companyId, runId, issueId, reviewerId, now };
    }

    const expire = (companyId: string, runId: string, now: Date) =>
      createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", staleAfterMs, now,
      });

    it("keeps a run that waits for its agent's own slot while that agent has a running run", async () => {
      const { companyId, runId, now } = await seedWaitingRun({
        waitContext: ownSlotWait,
        otherRun: { agent: "same", status: "running" },
      });

      const outcome = await expire(companyId, runId, now);

      expect(outcome.outcome).toBe("not_stale");
      expect(await runStatus(runId)).toMatchObject({ status: "queued", errorCode: null });
    });

    it("still expires it when no run of the agent is running: a named ceiling without a run behind it is a lost start", async () => {
      const finished = await seedWaitingRun({
        waitContext: ownSlotWait,
        otherRun: { agent: "same", status: "succeeded" },
      });
      expect(await expire(finished.companyId, finished.runId, finished.now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });

      const alone = await seedWaitingRun({ waitContext: ownSlotWait, otherRun: null });
      expect(await expire(alone.companyId, alone.runId, alone.now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("still expires it when only another agent is running", async () => {
      const { companyId, runId, now } = await seedWaitingRun({
        waitContext: ownSlotWait,
        otherRun: { agent: "other", status: "running" },
      });

      expect(await expire(companyId, runId, now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("still expires a run the sweep holds for another reason, or for none, even while the agent runs", async () => {
      const unnamed = await seedWaitingRun({ otherRun: { agent: "same", status: "running" } });
      expect(await expire(unnamed.companyId, unnamed.runId, unnamed.now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });

      const maintenance = await seedWaitingRun({
        waitContext: { waitReason: "maintenance" },
        otherRun: { agent: "same", status: "running" },
      });
      expect(await expire(maintenance.companyId, maintenance.runId, maintenance.now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("does not shield the run from the task-state checks: a reassigned task still cancels it", async () => {
      const { companyId, runId, issueId, reviewerId, now } = await seedWaitingRun({
        wakeReason: "issue_assigned",
        waitContext: ownSlotWait,
        otherRun: { agent: "same", status: "running" },
      });
      await db.update(issues).set({ assigneeAgentId: reviewerId }).where(eq(issues.id, issueId));

      expect(await expire(companyId, runId, now))
        .toMatchObject({ outcome: "cancelled", errorCode: "issue_assignee_changed" });
    });
  });

  // myrmidon(EMPTY-RUNS-6B): the slot of the agent frees, and the run that waited
  // for it must start (with its own wake reason), not be expired in that second.
  describe("a run that waited for its agent's slot is not expired when the slot frees (EMPTY-RUNS-6B)", () => {
    const MIN = 60 * 1000;
    const staleAfterMs = 30 * MIN;
    const ownSlotWait = { waitReason: "agent_concurrency", waitDetail: { limit: 1, running: 0 } };

    /** Waiting runs created 40 min ago; the agent's other run ended `finishedAgoMs` before now (null: none). */
    async function seedAfterSlotFreed(input: {
      finishedAgoMs: number | null;
      waiting?: number;
      waitContext?: Record<string, unknown>;
      other?: { agent?: "same" | "other"; started?: boolean };
    }) {
      const { companyId, assigneeId, reviewerId, issueId } = await seed();
      const now = new Date();
      const runIds: string[] = [];
      for (let i = 0; i < (input.waiting ?? 1); i += 1) {
        runIds.push(await seedRun({
          companyId,
          agentId: assigneeId,
          contextSnapshot: { issueId, wakeReason: "ci_completed", ...(input.waitContext ?? ownSlotWait) },
          createdAt: new Date(now.getTime() - 40 * MIN),
        }));
      }
      if (input.finishedAgoMs !== null) {
        const startedAt = new Date(now.getTime() - 60 * MIN);
        const started = input.other?.started ?? true;
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId: input.other?.agent === "other" ? reviewerId : assigneeId,
          invocationSource: "automation",
          status: started ? "succeeded" : "cancelled",
          contextSnapshot: {},
          createdAt: startedAt,
          startedAt: started ? startedAt : null,
          finishedAt: new Date(now.getTime() - input.finishedAgoMs),
        });
      }
      return { companyId, runIds, now };
    }

    const expire = (companyId: string, runId: string, now: Date) =>
      createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", staleAfterMs, now,
      });

    it("keeps a run waited 40 minutes behind a run that finished a second ago", async () => {
      const { companyId, runIds, now } = await seedAfterSlotFreed({ finishedAgoMs: 1000 });
      expect((await expire(companyId, runIds[0]!, now)).outcome).toBe("not_stale");
      expect(await runStatus(runIds[0]!)).toMatchObject({ status: "queued", errorCode: null });
    });

    it("expires it as before when the slot has been free for longer than the threshold", async () => {
      const { companyId, runIds, now } = await seedAfterSlotFreed({ finishedAgoMs: 35 * MIN });
      expect(await expire(companyId, runIds[0]!, now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("keeps every one of two waiting runs older than the threshold when the slot just freed", async () => {
      const { companyId, runIds, now } = await seedAfterSlotFreed({ finishedAgoMs: 1000, waiting: 2 });
      for (const runId of runIds) {
        expect((await expire(companyId, runId, now)).outcome).toBe("not_stale");
        expect(await runStatus(runId)).toMatchObject({ status: "queued", errorCode: null });
      }
    });

    it("a run cancelled in the queue (never started) does not refresh the protection", async () => {
      const { companyId, runIds, now } = await seedAfterSlotFreed({ finishedAgoMs: 1000, other: { started: false } });
      expect(await expire(companyId, runIds[0]!, now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("a run that ended before the wait began does not protect it", async () => {
      // waiting since 40 min ago, the other run ended 45 min ago (threshold 35 min)
      const { companyId, runIds, now } = await seedAfterSlotFreed({ finishedAgoMs: 45 * MIN });
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId: runIds[0]!, companyId, expectedStatus: "queued", staleAfterMs: 35 * MIN, now,
      })).toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("a run of another agent that just finished does not protect it", async () => {
      const { companyId, runIds, now } = await seedAfterSlotFreed({ finishedAgoMs: 1000, other: { agent: "other" } });
      expect(await expire(companyId, runIds[0]!, now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("does not extend the wait of a run the sweep named for another reason", async () => {
      const { companyId, runIds, now } = await seedAfterSlotFreed({
        finishedAgoMs: 1000,
        waitContext: { waitReason: "maintenance" },
      });
      expect(await expire(companyId, runIds[0]!, now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });
  });

  // myrmidon(EMPTY-RUNS-6C): in the pass that frees the slot the start sweep takes
  // the heaviest waiting run and renames the wait of the others to `priority`.
  // The age sweep of the same second must treat that wait as the wait for the
  // agent's own slot (14.11, adm-dev-eng-24: two runs waited 77 and 47 minutes,
  // the running run failed, both were cancelled with `waitReason = priority`).
  describe("runs renamed to a priority wait at slot release are not expired (EMPTY-RUNS-6C)", () => {
    const MIN = 60 * 1000;
    const staleAfterMs = 30 * MIN;

    /**
     * Two runs of the assignee waiting 77 and 47 minutes with their own wake
     * reasons and the wait reason the start pass left on them; the agent's
     * previous run ended with `previous` a second ago; `next` is the run the
     * pass started in the same second (or none).
     */
    async function seedSlotRelease(input: {
      previous: "failed" | "succeeded" | "cancelled";
      next: "running" | null;
      waitReason?: string;
    }) {
      const { companyId, assigneeId, issueId } = await seed();
      const now = new Date();
      const waitReason = input.waitReason ?? "priority";
      const oldest = await seedRun({
        companyId, agentId: assigneeId,
        contextSnapshot: { issueId, wakeReason: "pause_resume", waitReason },
        createdAt: new Date(now.getTime() - 77 * MIN),
      });
      const younger = await seedRun({
        companyId, agentId: assigneeId,
        contextSnapshot: { issueId, wakeReason: "execution_changes_requested", waitReason },
        createdAt: new Date(now.getTime() - 47 * MIN),
      });
      const startedAt = new Date(now.getTime() - 58 * MIN);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId, agentId: assigneeId, invocationSource: "automation",
        status: input.previous, contextSnapshot: {},
        createdAt: startedAt, startedAt, finishedAt: new Date(now.getTime() - 1000),
      });
      if (input.next) {
        await db.insert(heartbeatRuns).values({
          id: randomUUID(), companyId, agentId: assigneeId, invocationSource: "automation",
          status: input.next, contextSnapshot: {},
          createdAt: new Date(now.getTime() - 26 * MIN), startedAt: new Date(now.getTime() - 500), finishedAt: null,
        });
      }
      return { companyId, runIds: [oldest, younger], now };
    }

    const expire = (companyId: string, runId: string, now: Date) =>
      createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId, companyId, expectedStatus: "queued", staleAfterMs, now,
      });

    for (const previous of ["failed", "succeeded", "cancelled"] as const) {
      it(`keeps both waiting runs when the running run ended ${previous} and another run of the agent started`, async () => {
        const { companyId, runIds, now } = await seedSlotRelease({ previous, next: "running" });
        for (const runId of runIds) {
          expect((await expire(companyId, runId, now)).outcome).toBe("not_stale");
          expect(await runStatus(runId)).toMatchObject({ status: "queued", errorCode: null });
        }
        const [oldest, younger] = await Promise.all(runIds.map(async (id) =>
          (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!));
        expect(oldest!.contextSnapshot).toMatchObject({ wakeReason: "pause_resume" });
        expect(younger!.contextSnapshot).toMatchObject({ wakeReason: "execution_changes_requested" });
      });

      it(`keeps both waiting runs when the running run ended ${previous} and nothing started yet`, async () => {
        const { companyId, runIds, now } = await seedSlotRelease({ previous, next: null });
        for (const runId of runIds) {
          expect((await expire(companyId, runId, now)).outcome).toBe("not_stale");
        }
      });
    }

    it("keeps the runs that still carry agent_concurrency when the running run failed", async () => {
      const { companyId, runIds, now } = await seedSlotRelease({
        previous: "failed", next: "running", waitReason: "agent_concurrency",
      });
      for (const runId of runIds) expect((await expire(companyId, runId, now)).outcome).toBe("not_stale");
    });

    it("still expires a priority-waiting run of an agent with a free slot: nothing running, slot free past the threshold", async () => {
      const { companyId, assigneeId, issueId } = await seed();
      const now = new Date();
      const runId = await seedRun({
        companyId, agentId: assigneeId,
        contextSnapshot: { issueId, wakeReason: "ci_completed", waitReason: "priority" },
        createdAt: new Date(now.getTime() - 40 * MIN),
      });
      const startedAt = new Date(now.getTime() - 90 * MIN);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId, agentId: assigneeId, invocationSource: "automation",
        status: "failed", contextSnapshot: {}, createdAt: startedAt, startedAt,
        finishedAt: new Date(now.getTime() - 60 * MIN),
      });
      expect(await expire(companyId, runId, now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
    });

    it("still expires a run with a free slot and no run of the agent at all", async () => {
      const { companyId, assigneeId, issueId } = await seed();
      const now = new Date();
      const runId = await seedRun({
        companyId, agentId: assigneeId,
        contextSnapshot: { issueId, wakeReason: "ci_completed" },
        createdAt: new Date(now.getTime() - 40 * MIN),
      });
      expect(await expire(companyId, runId, now))
        .toMatchObject({ outcome: "cancelled", errorCode: "queued_run_stale_timeout" });
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
