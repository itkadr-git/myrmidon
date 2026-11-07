// myrmidon(RUN-GUARD-LOOPS): a run the run guard stopped is not retried; its
// issue goes to blocked with a comment saying why. Transport failures keep
// their retry path.
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
import { CONNECT_FAILED_TRANSIENT_RETRY_REASON, heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run guard no-retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-03-19T00:00:00.000Z");

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
            runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
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
            runtimeConfig: {},
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
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
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
