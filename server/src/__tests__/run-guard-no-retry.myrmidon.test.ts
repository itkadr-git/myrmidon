// myrmidon(RUN-GUARD-LOOPS): a run the run guard stopped is not retried; its
// issue goes to blocked with a comment saying why. Transport failures keep
// their retry path.
// myrmidon(RUN-GUARD-CONTINUE): the one exception is a call-limit stop of a run
// that made changes: the work continues in a follow-up run (the max-turn
// continuation machinery) and the issue is not blocked. These continuations have
// their own ceiling (heartbeat.runGuardContinuation.maxAttempts, default 6, at
// most 20) and do not spend the max-turn one (heartbeat.maxTurnContinuation).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RUN_GUARD_STOP_REASONS } from "@myrmidon/adapter-utils/run-guard";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  CONNECT_FAILED_TRANSIENT_RETRY_REASON,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.js";
import { maxTurnContinuationSchedulerCeiling } from "../myrmidon/run-guard-stop.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run guard no-retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-03-19T00:00:00.000Z");
// A run that ended on the turn limit (not stopped by the run guard), as the max-turn tests seed it.
const MAX_TURNS_RESULT = {
  executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
  stopReason: "max_turns_exhausted",
};

describeEmbeddedPostgres("run guard stops are not retried", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-run-guard-no-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    // Take every issue of the finished test out of later stranded-issue sweeps.
    await db.update(issues).set({ status: "cancelled" });
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await tempDb?.cleanup();
  });

  /**
   * Company, agent, an in_progress issue assigned to it, and one finished run
   * of that agent on the issue. `shape: "retry"` mirrors the issue the bounded
   * retry scheduler tests use (the run still holds the execution lock);
   * `shape: "stranded"` mirrors the stranded-issue sweep tests (checked out,
   * no live execution).
   */
  async function seedRun(input: {
    shape: "retry" | "stranded";
    status: "cancelled" | "failed";
    errorCode: string;
    error?: string;
    resultJson?: Record<string, unknown>;
    issueStatus?: "todo" | "in_progress";
    /** The stopped run is itself continuation number N of a chain (myrmidon(RUN-GUARD-CONTINUE)). */
    scheduledRetryAttempt?: number;
    /** Call-limit continuations the chain of the stopped run has already made (myrmidon(RUN-GUARD-CONTINUE)). */
    runGuardContinuationAttempts?: number;
    runtimeConfig?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueStatus = input.issueStatus ?? "in_progress";

    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      input.shape === "retry"
        ? {
            id: agentId,
            companyId,
            name: "ClaudeCoder",
            role: "engineer",
            status: "active",
            adapterType: "claude_local",
            adapterConfig: {},
            runtimeConfig: input.runtimeConfig ?? { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
            permissions: {},
          }
        : {
            id: agentId,
            companyId,
            name: "CodexCoder",
            role: "engineer",
            status: "idle",
            adapterType: "codex_local",
            adapterConfig: {},
            runtimeConfig: input.runtimeConfig ?? {},
            permissions: {},
          },
    );
    if (input.shape === "stranded") {
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: input.status === "cancelled" ? "cancelled" : "failed",
        runId,
        claimedAt: NOW,
        finishedAt: new Date(NOW.getTime() + 5_000),
        error: input.error ?? "run stopped",
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.status,
      wakeupRequestId: input.shape === "stranded" ? wakeupRequestId : null,
      error: input.error ?? "run stopped",
      errorCode: input.errorCode,
      resultJson: input.resultJson ?? {},
      ...(input.scheduledRetryAttempt
        ? {
            scheduledRetryAttempt: input.scheduledRetryAttempt,
            scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
          }
        : {}),
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        ...(input.runGuardContinuationAttempts
          ? { runGuardContinuationAttempts: input.runGuardContinuationAttempts }
          : {}),
      },
      startedAt: NOW,
      finishedAt: new Date(NOW.getTime() + 5_000),
      updatedAt: new Date(NOW.getTime() + 5_000),
      createdAt: NOW,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task whose run was stopped",
      status: issueStatus,
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      ...(input.shape === "retry"
        ? { executionRunId: runId, executionAgentNameKey: "claudecoder", executionLockedAt: NOW }
        : { checkoutRunId: issueStatus === "in_progress" ? runId : null, executionRunId: null }),
      startedAt: issueStatus === "in_progress" ? NOW : null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId, runId };
  }

  async function successorsOf(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  }

  async function issueState(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    return { status: issue?.status, comments };
  }

  it.each([...RUN_GUARD_STOP_REASONS])("schedules no automatic retry for a run stopped with %s", async (reason) => {
    const { runId } = await seedRun({
      shape: "retry",
      status: "cancelled",
      errorCode: reason,
      error: `Run stopped by guard: ${reason}`,
      resultJson: { runGuardStopReason: reason },
    });

    const outcome = await heartbeat.scheduleBoundedRetry(runId, { now: NOW, random: () => 0 });

    expect(outcome).toMatchObject({ outcome: "not_scheduled", errorCode: "run_guard_stopped" });
    expect(await successorsOf(runId)).toHaveLength(0);
  });

  it("still retries a gateway connect failure", async () => {
    const { runId } = await seedRun({
      shape: "retry",
      status: "failed",
      errorCode: "hermes_gateway_connect_failed",
      error: "Hermes gateway request failed: fetch failed (ECONNREFUSED)",
      resultJson: {
        error: "Hermes gateway request failed: fetch failed (ECONNREFUSED)",
        errorCode: "hermes_gateway_connect_failed",
      },
    });

    const outcome = await heartbeat.scheduleBoundedRetry(runId, { now: NOW, random: () => 0 });

    expect(outcome.outcome).toBe("scheduled");
    if (outcome.outcome !== "scheduled") throw new Error("Expected a scheduled retry");
    expect(outcome.run.scheduledRetryReason).toBe(CONNECT_FAILED_TRANSIENT_RETRY_REASON);
    expect(await successorsOf(runId)).toHaveLength(1);
  });

  it("blocks the assignee's issue with a comment that says why and that no retry follows", async () => {
    const { issueId, runId } = await seedRun({
      shape: "stranded",
      status: "cancelled",
      errorCode: "no_progress_exploration",
      error: "Run stopped by guard: no_progress_exploration",
      resultJson: {
        runGuardStopReason: "no_progress_exploration",
        runGuardStats: { toolCalls: 40, readOnlyStreak: 40, modelCalls: 41 },
      },
    });

    expect(await heartbeat.applyRunGuardStop(runId)).toMatchObject({ outcome: "handled" });

    const state = await issueState(issueId);
    expect(state.status).toBe("blocked");
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]?.body).toBe(
      "Прогон остановлен защитой: только чтение без изменений (40 вызовов без записи). " +
        "Нужна новая вводная: уточнить задачу или разбить её; автоповтора не будет.",
    );
    expect(await successorsOf(runId)).toHaveLength(0);

    // A second application (a repair pass) finds the issue already blocked: no second comment.
    await heartbeat.applyRunGuardStop(runId);
    expect((await issueState(issueId)).comments).toHaveLength(1);
  });

  it("leaves the issue alone when the stopped run belongs to an agent that is not the assignee", async () => {
    const { agentId, companyId, issueId, runId } = await seedRun({
      shape: "stranded",
      status: "cancelled",
      errorCode: "repeated_tool_call",
      resultJson: { runGuardStopReason: "repeated_tool_call" },
    });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId));

    await heartbeat.applyRunGuardStop(runId);

    expect(agentId).not.toBe(otherAgentId);
    expect((await issueState(issueId)).status).toBe("in_progress");
  });

  it("makes the stranded-issue sweep block the issue instead of retrying the stopped run", async () => {
    const { agentId, issueId, runId } = await seedRun({
      shape: "stranded",
      status: "cancelled",
      errorCode: "model_call_limit",
      error: "Run stopped by guard: model_call_limit",
      resultJson: {
        runGuardStopReason: "model_call_limit",
        runGuardStats: { toolCalls: 150, readOnlyStreak: 33, modelCalls: 150 },
      },
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.issueIds).toContain(issueId);
    const state = await issueState(issueId);
    expect(state.status).toBe("blocked");
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]?.body).toBe(
      "Прогон остановлен защитой: лимит вызовов модели (33 вызова без записи). " +
        "Нужна новая вводная: уточнить задачу или разбить её; автоповтора не будет.",
    );
    expect(await successorsOf(runId)).toHaveLength(0);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId)));
    expect(runs.map((run) => run.id)).toEqual([runId]);
  });

  // myrmidon(RUN-GUARD-CONTINUE): a call-limit stop of a run that made changes continues the work.
  describe("call-limit stop of a run that made changes", () => {
    const CHANGING_STATS = { toolCalls: 143, writeCalls: 33, readOnlyStreak: 4, modelCalls: 150 };

    it("continues the work in a follow-up run and leaves the issue and its comments alone", async () => {
      const { issueId, runId } = await seedRun({
        shape: "retry",
        status: "cancelled",
        errorCode: "model_call_limit",
        error: "Run stopped by guard: model_call_limit",
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: CHANGING_STATS },
      });

      expect(await heartbeat.applyRunGuardStop(runId)).toMatchObject({ outcome: "handled", issue: null });

      const successors = await successorsOf(runId);
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({
        status: "scheduled_retry",
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        scheduledRetryAttempt: 1,
        retryOfRunId: runId,
      });
      const state = await issueState(issueId);
      expect(state.status).toBe("in_progress");
      expect(state.comments).toHaveLength(0);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.executionRunId).toBe(successors[0]?.id);
    });

    it("continues a continuation too, as long as the attempt ceiling allows", async () => {
      const { issueId, runId } = await seedRun({
        shape: "retry",
        status: "cancelled",
        errorCode: "model_call_limit",
        scheduledRetryAttempt: 1,
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: CHANGING_STATS },
      });

      await heartbeat.applyRunGuardStop(runId);

      const successors = await successorsOf(runId);
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ scheduledRetryAttempt: 2, scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON });
      expect((await issueState(issueId)).status).toBe("in_progress");
    });

    // Stops the run a scheduled follow-up is, the way the guard would, and applies the stop handling to it.
    async function stopFollowUp(runId: string, stats: Record<string, unknown>) {
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          errorCode: "model_call_limit",
          resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: stats },
          startedAt: NOW,
          finishedAt: new Date(NOW.getTime() + 5_000),
        })
        .where(eq(heartbeatRuns.id, runId));
      return heartbeat.applyRunGuardStop(runId);
    }

    it("keeps continuing past the max-turn ceiling: three stops in a row with changes, a 4th continuation is queued", async () => {
      // The max-turn ceiling is 2 by default; the chain below is 3 stops long.
      const { issueId, runId } = await seedRun({
        shape: "retry",
        status: "cancelled",
        errorCode: "model_call_limit",
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: CHANGING_STATS },
      });

      await heartbeat.applyRunGuardStop(runId);
      let previous = runId;
      for (const expectedAttempt of [1, 2, 3]) {
        const [successor] = await successorsOf(previous);
        expect(successor).toMatchObject({
          status: "scheduled_retry",
          scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
          scheduledRetryAttempt: expectedAttempt,
        });
        expect((successor?.contextSnapshot as Record<string, unknown>).runGuardContinuationAttempts).toBe(expectedAttempt);
        expect((await issueState(issueId)).status).toBe("in_progress");
        previous = successor!.id;
        // The follow-up runs, changes things and hits the call limit again.
        await stopFollowUp(previous, CHANGING_STATS);
      }

      const fourth = await successorsOf(previous);
      expect(fourth).toHaveLength(1);
      expect(fourth[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 4 });
      const state = await issueState(issueId);
      expect(state.status).toBe("in_progress");
      expect(state.comments).toHaveLength(0);
    });

    it("blocks the issue with the usual comment when the own continuation ceiling (6) is spent", async () => {
      const { issueId, runId } = await seedRun({
        shape: "stranded",
        status: "cancelled",
        errorCode: "model_call_limit",
        scheduledRetryAttempt: 6,
        runGuardContinuationAttempts: 6,
        resultJson: {
          runGuardStopReason: "model_call_limit",
          runGuardStats: { toolCalls: 140, writeCalls: 20, readOnlyStreak: 0, modelCalls: 150 },
        },
      });

      await heartbeat.applyRunGuardStop(runId);

      const state = await issueState(issueId);
      expect(state.status).toBe("blocked");
      expect(state.comments).toHaveLength(1);
      expect(state.comments[0]?.body).toBe(
        "Прогон остановлен защитой: лимит вызовов модели (150 вызовов модели). " +
          "Нужна новая вводная: уточнить задачу или разбить её; автоповтора не будет.",
      );
      expect(await successorsOf(runId)).toHaveLength(0);
    });

    it("continues the 6th continuation and not the 7th", async () => {
      const fifth = await seedRun({
        shape: "retry",
        status: "cancelled",
        errorCode: "model_call_limit",
        scheduledRetryAttempt: 5,
        runGuardContinuationAttempts: 5,
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: CHANGING_STATS },
      });
      await heartbeat.applyRunGuardStop(fifth.runId);
      const [sixth] = await successorsOf(fifth.runId);
      expect(sixth).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 6 });

      expect(await stopFollowUp(sixth!.id, CHANGING_STATS)).toMatchObject({ outcome: "handled" });
      expect(await successorsOf(sixth!.id)).toHaveLength(0);
      expect((await issueState(fifth.issueId)).status).toBe("blocked");
    });

    it("reads the own ceiling from heartbeat.runGuardContinuation.maxAttempts, capped at 20", async () => {
      const lowCeiling = await seedRun({
        shape: "stranded",
        status: "cancelled",
        errorCode: "model_call_limit",
        scheduledRetryAttempt: 3,
        runGuardContinuationAttempts: 3,
        runtimeConfig: { heartbeat: { runGuardContinuation: { maxAttempts: 3 } } },
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: CHANGING_STATS },
      });
      await heartbeat.applyRunGuardStop(lowCeiling.runId);
      expect((await issueState(lowCeiling.issueId)).status).toBe("blocked");
      expect(await successorsOf(lowCeiling.runId)).toHaveLength(0);

      const highCeiling = await seedRun({
        shape: "retry",
        status: "cancelled",
        errorCode: "model_call_limit",
        scheduledRetryAttempt: 12,
        runGuardContinuationAttempts: 12,
        runtimeConfig: { heartbeat: { runGuardContinuation: { maxAttempts: 15 } } },
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: CHANGING_STATS },
      });
      await heartbeat.applyRunGuardStop(highCeiling.runId);
      expect(await successorsOf(highCeiling.runId)).toHaveLength(1);

      const cappedCeiling = await seedRun({
        shape: "stranded",
        status: "cancelled",
        errorCode: "model_call_limit",
        scheduledRetryAttempt: 20,
        runGuardContinuationAttempts: 20,
        runtimeConfig: { heartbeat: { runGuardContinuation: { maxAttempts: 99 } } },
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: CHANGING_STATS },
      });
      await heartbeat.applyRunGuardStop(cappedCeiling.runId);
      expect((await issueState(cappedCeiling.issueId)).status).toBe("blocked");
      expect(await successorsOf(cappedCeiling.runId)).toHaveLength(0);
    });

    it("blocks a stop of a run that changed nothing even in the middle of a chain of continuations", async () => {
      const { issueId, runId } = await seedRun({
        shape: "stranded",
        status: "cancelled",
        errorCode: "model_call_limit",
        scheduledRetryAttempt: 3,
        runGuardContinuationAttempts: 3,
        resultJson: {
          runGuardStopReason: "model_call_limit",
          runGuardStats: { toolCalls: 150, writeCalls: 0, readOnlyStreak: 33, modelCalls: 150 },
        },
      });

      await heartbeat.applyRunGuardStop(runId);

      expect((await issueState(issueId)).status).toBe("blocked");
      expect(await successorsOf(runId)).toHaveLength(0);
    });

    it("lets a max-turn stop later in the chain use its whole ceiling, whatever call-limit continuations came before", async () => {
      // Shared counter 3 = three call-limit continuations; the max-turn ceiling of 2 is still unspent.
      const { runId } = await seedRun({
        shape: "retry",
        status: "failed",
        errorCode: "adapter_failed",
        error: "Maximum turns reached",
        resultJson: MAX_TURNS_RESULT,
        scheduledRetryAttempt: 3,
        runGuardContinuationAttempts: 3,
      });
      const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));

      const outcome = await heartbeat.scheduleBoundedRetry(runId, {
        now: NOW,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        maxAttempts: maxTurnContinuationSchedulerCeiling(2, stored),
        delayMs: 1_000,
      });

      expect(outcome).toMatchObject({ outcome: "scheduled", attempt: 4 });
    });

    it("exhausts the max-turn ceiling as before when no call-limit continuation was made", async () => {
      const { runId } = await seedRun({
        shape: "retry",
        status: "failed",
        errorCode: "adapter_failed",
        error: "Maximum turns reached",
        resultJson: MAX_TURNS_RESULT,
        scheduledRetryAttempt: 2,
      });
      const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));

      const outcome = await heartbeat.scheduleBoundedRetry(runId, {
        now: NOW,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        maxAttempts: maxTurnContinuationSchedulerCeiling(2, stored),
        delayMs: 1_000,
      });

      expect(outcome).toMatchObject({ outcome: "retry_exhausted" });
    });

    it("blocks the issue when the max-turn continuation policy of the agent is off", async () => {
      const { issueId, runId } = await seedRun({
        shape: "stranded",
        status: "cancelled",
        errorCode: "model_call_limit",
        runtimeConfig: { heartbeat: { maxTurnContinuation: { enabled: false } } },
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: CHANGING_STATS },
      });

      await heartbeat.applyRunGuardStop(runId);

      expect((await issueState(issueId)).status).toBe("blocked");
      expect(await successorsOf(runId)).toHaveLength(0);
    });

    it("blocks the issue when the stats say the run changed nothing (writeCalls 0 or not recorded)", async () => {
      for (const runGuardStats of [
        { toolCalls: 150, writeCalls: 0, readOnlyStreak: 33, modelCalls: 150 },
        { toolCalls: 150, readOnlyStreak: 33, modelCalls: 150 },
      ]) {
        const { issueId, runId } = await seedRun({
          shape: "stranded",
          status: "cancelled",
          errorCode: "model_call_limit",
          resultJson: { runGuardStopReason: "model_call_limit", runGuardStats },
        });

        await heartbeat.applyRunGuardStop(runId);

        const state = await issueState(issueId);
        expect(state.status).toBe("blocked");
        expect(state.comments[0]?.body).toContain("лимит вызовов модели (33 вызова без записи)");
        expect(await successorsOf(runId)).toHaveLength(0);
      }
    });

    it.each(RUN_GUARD_STOP_REASONS.filter((reason) => reason !== "model_call_limit"))(
      "still blocks the issue for %s, whatever the run changed",
      async (reason) => {
        const { issueId, runId } = await seedRun({
          shape: "stranded",
          status: "cancelled",
          errorCode: reason,
          resultJson: {
            runGuardStopReason: reason,
            runGuardStats: { toolCalls: 60, writeCalls: 12, readOnlyStreak: 40, modelCalls: 61 },
          },
        });

        await heartbeat.applyRunGuardStop(runId);

        expect((await issueState(issueId)).status).toBe("blocked");
        expect(await successorsOf(runId)).toHaveLength(0);
      },
    );

    it("still refuses the continuation to a caller that did not come through the guard stop handling", async () => {
      const { runId } = await seedRun({
        shape: "retry",
        status: "cancelled",
        errorCode: "model_call_limit",
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: CHANGING_STATS },
      });

      const outcome = await heartbeat.scheduleBoundedRetry(runId, {
        now: NOW,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        maxAttempts: 2,
        delayMs: 1_000,
      });

      expect(outcome).toMatchObject({ outcome: "not_scheduled", errorCode: "run_guard_stopped" });
      expect(await successorsOf(runId)).toHaveLength(0);
    });
  });

  it("does not queue a continuation for a stopped run on a todo issue", async () => {
    const { agentId, runId } = await seedRun({
      shape: "stranded",
      status: "cancelled",
      issueStatus: "todo",
      errorCode: "tool_retry_loop",
      resultJson: { runGuardStopReason: "tool_retry_loop" },
    });

    await heartbeat.reconcileStrandedAssignedIssues();

    expect(await successorsOf(runId)).toHaveLength(0);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.map((run) => run.id)).toEqual([runId]);
  });
});
