// myrmidon(RUN-GUARD-ESCALATE): a task the run guard stopped for good (blocked
// with "a new input is needed") wakes the assignee's manager with the wake reason
// `run_guard_stop_needs_input`: reports_to, else the agent `adm`, else nobody. The
// assignee and the blocked status stay as the escalation set them. One wake per
// block episode: while the task has not left `blocked` since the previous wake
// there is no second one; once it was put back, the next stop wakes again. An
// assignee that is `adm` itself wakes nobody. The run dispatch lets the wake start
// only for the assignee's reports_to or `adm`, and only on a blocked issue.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  RUN_GUARD_STOP_NEEDS_INPUT_SOURCE,
  RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON,
  hasRunGuardStopWakeInBlockEpisode,
  isRunGuardStopWakeRecipient,
} from "../myrmidon/run-guard-escalation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run guard escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const STOPPED_AT = new Date("2026-03-19T00:00:00.000Z");
const LOOP_STATS = { toolCalls: 40, readOnlyStreak: 40, modelCalls: 41 };

describeEmbeddedPostgres("a final run guard stop wakes the manager", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-run-guard-escalate-");
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

  async function insertAgent(input: {
    companyId: string;
    name: string;
    reportsTo?: string | null;
    status?: "idle" | "paused";
  }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId: input.companyId,
      name: input.name,
      role: "engineer",
      status: input.status ?? "idle",
      reportsTo: input.reportsTo ?? null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  /** A guard-stopped run of the assignee on the issue (the issue is checked out, no live execution). */
  async function insertStoppedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    reason?: string;
    stats?: Record<string, unknown>;
  }) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const reason = input.reason ?? "no_progress_exploration";
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: "cancelled",
      runId,
      claimedAt: STOPPED_AT,
      finishedAt: new Date(STOPPED_AT.getTime() + 5_000),
      error: `Run stopped by guard: ${reason}`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      wakeupRequestId,
      error: `Run stopped by guard: ${reason}`,
      errorCode: reason,
      resultJson: { runGuardStopReason: reason, runGuardStats: input.stats ?? LOOP_STATS },
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_assigned" },
      startedAt: STOPPED_AT,
      finishedAt: new Date(STOPPED_AT.getTime() + 5_000),
      updatedAt: new Date(STOPPED_AT.getTime() + 5_000),
      createdAt: STOPPED_AT,
    });
    return runId;
  }

  /** Company, an assignee (optionally reporting to a manager, optionally with an `adm` agent), an in_progress issue and one stopped run. */
  async function seed(input: {
    withManager: boolean;
    withAdm?: boolean;
    managerStatus?: "idle" | "paused";
    assigneeName?: string;
  }) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    const managerId = input.withManager
      ? await insertAgent({ companyId, name: "Lead", status: input.managerStatus })
      : null;
    const admId = input.withAdm ? await insertAgent({ companyId, name: "adm" }) : null;
    const agentId = await insertAgent({ companyId, name: input.assigneeName ?? "CodexCoder", reportsTo: managerId });
    const runId = await insertStoppedRun({ companyId, agentId, issueId });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task whose run was stopped",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: null,
      startedAt: STOPPED_AT,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, issueId, agentId, managerId, admId, runId };
  }

  async function wakesFor(companyId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON),
        ),
      );
  }

  async function issueRow(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return issue!;
  }

  /** The wake the board sends, sent as a given agent: what the run dispatch has to judge. */
  async function wakeAs(agentId: string, issueId: string) {
    const returned = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON,
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON,
        source: RUN_GUARD_STOP_NEEDS_INPUT_SOURCE,
      },
    });
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON)));
    return { wake, returned };
  }

  /** What the manager's PATCH leaves behind: an `issue.updated` activity row that moves the status away from `blocked`. */
  async function logLeftBlocked(input: { companyId: string; issueId: string; at: Date; shape?: "changes" | "previousStatus" | "_previous" }) {
    const shape = input.shape ?? "changes";
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: "manager",
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issueId,
      details:
        shape === "changes"
          ? { changes: { status: { from: "blocked", to: "todo" } } }
          : shape === "previousStatus"
            ? { status: "todo", previousStatus: "blocked" }
            : { status: "todo", _previous: { status: "blocked" } },
      createdAt: input.at,
    });
  }

  it("wakes the assignee's manager with the reason, the issue and the stop text, and leaves the assignee and the blocked status", async () => {
    const { companyId, issueId, agentId, managerId, runId } = await seed({ withManager: true, withAdm: true });

    await heartbeat.applyRunGuardStop(runId);

    const wakes = await wakesFor(companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId: managerId,
      reason: RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON,
      status: expect.not.stringMatching(/^skipped$/),
    });
    expect(wakes[0]?.payload).toMatchObject({
      issueId,
      assigneeAgentId: agentId,
      runGuardStop: {
        runId,
        reason: "no_progress_exploration",
        text:
          "Прогон остановлен защитой: только чтение без изменений (40 вызовов без записи). " +
          "Нужна новая вводная: уточнить задачу или разбить её; автоповтора не будет.",
      },
    });
    const issue = await issueRow(issueId);
    expect(issue.status).toBe("blocked");
    expect(issue.assigneeAgentId).toBe(agentId);
  });

  // myrmidon(OPE-12577): the stopped run's environment lease is released a moment
  // after the stop; until then it is an execution hold. The manager's wake sent
  // right after the block was parked behind it as an execution wait
  // (execution_reconciliation_required) and never ran.
  it("wakes the manager while the stopped run still holds its environment lease", async () => {
    const { companyId, issueId, agentId, managerId, runId } = await seed({ withManager: true, withAdm: true });
    await db
      .update(heartbeatRuns)
      .set({ runnerProfileJson: { adapterDispatch: { adapterType: "hermes_gateway" } } })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, status: "active" });

    await heartbeat.applyRunGuardStop(runId);

    const wakes = await wakesFor(companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: managerId, reason: RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON });
    expect(wakes[0]?.status).not.toMatch(/^(skipped|deferred_issue_execution)$/);
    const parked = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "execution_reconciliation_required")));
    expect(parked).toHaveLength(0);
    const issue = await issueRow(issueId);
    expect(issue.status).toBe("blocked");
    expect(issue.assigneeAgentId).toBe(agentId);
  });

  it("does not wake the manager a second time while the task has not left blocked since the first wake", async () => {
    const { companyId, issueId, agentId, runId } = await seed({ withManager: true });
    await heartbeat.applyRunGuardStop(runId);
    const [first] = await wakesFor(companyId);
    expect(first).toBeDefined();

    // Five minutes later the task is stopped again without anybody having put it back
    // (the only status activity is older than the wake: the one that blocked it).
    await db
      .update(agentWakeupRequests)
      .set({ requestedAt: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(agentWakeupRequests.id, first!.id));
    await logLeftBlocked({ companyId, issueId, at: new Date(Date.now() - 6 * 60 * 1000) });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const secondRunId = await insertStoppedRun({ companyId, agentId, issueId, reason: "repeated_tool_call" });

    await heartbeat.applyRunGuardStop(secondRunId);

    expect(await wakesFor(companyId)).toHaveLength(1);
    // The issue is blocked again all the same: only the wake is held back.
    expect((await issueRow(issueId)).status).toBe("blocked");
  });

  it("wakes the manager again five minutes later when he put the task back to todo and it was stopped anew", async () => {
    const { companyId, issueId, agentId, managerId, runId } = await seed({ withManager: true });
    await heartbeat.applyRunGuardStop(runId);
    const [first] = await wakesFor(companyId);
    expect(first).toBeDefined();

    // The manager's PATCH blocked -> todo, five minutes before the new stop.
    await db
      .update(agentWakeupRequests)
      .set({ requestedAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(agentWakeupRequests.id, first!.id));
    await logLeftBlocked({ companyId, issueId, at: new Date(Date.now() - 5 * 60 * 1000) });
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    // The manager's earlier run is over, so the new wake is not coalesced into it.
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, managerId!), eq(heartbeatRuns.status, "running")));
    const secondRunId = await insertStoppedRun({ companyId, agentId, issueId, reason: "tool_retry_loop" });

    await heartbeat.applyRunGuardStop(secondRunId);

    const wakes = await wakesFor(companyId);
    expect(wakes).toHaveLength(2);
    expect(wakes.every((wake) => wake.agentId === managerId)).toBe(true);
    expect((await issueRow(issueId)).status).toBe("blocked");
  });

  it("reads every shape the status change away from blocked is logged in, and only that", async () => {
    const { companyId, issueId, runId } = await seed({ withManager: true });
    await heartbeat.applyRunGuardStop(runId);
    const [first] = await wakesFor(companyId);
    const wakeAt = new Date(Date.now() - 10 * 60 * 1000);
    await db.update(agentWakeupRequests).set({ requestedAt: wakeAt }).where(eq(agentWakeupRequests.id, first!.id));
    const after = new Date(wakeAt.getTime() + 60 * 1000);
    const insideEpisode = () => hasRunGuardStopWakeInBlockEpisode(db, { companyId, issueId });

    expect(await insideEpisode()).toBe(true);
    // Other status changes, other actions, and the same change dated before the wake do not end the episode.
    await db.insert(activityLog).values([
      { companyId, actorType: "agent", actorId: "m", action: "issue.updated", entityType: "issue", entityId: issueId, details: { changes: { status: { from: "todo", to: "in_progress" } } }, createdAt: after },
      { companyId, actorType: "agent", actorId: "m", action: "issue.comment_added", entityType: "issue", entityId: issueId, details: { previousStatus: "blocked" }, createdAt: after },
    ]);
    await logLeftBlocked({ companyId, issueId, at: new Date(wakeAt.getTime() - 60 * 1000) });
    expect(await insideEpisode()).toBe(true);

    for (const shape of ["changes", "previousStatus", "_previous"] as const) {
      await db.delete(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.actorId, "manager")));
      await logLeftBlocked({ companyId, issueId, at: after, shape });
      expect(await insideEpisode(), shape).toBe(false);
    }
  });

  it("wakes the agent named adm when the assignee reports to nobody", async () => {
    const { companyId, issueId, admId, runId } = await seed({ withManager: false, withAdm: true });

    await heartbeat.applyRunGuardStop(runId);

    const wakes = await wakesFor(companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: admId, status: expect.not.stringMatching(/^skipped$/) });
    expect(wakes[0]?.payload).toMatchObject({ issueId });
  });

  it("wakes the agent named adm when the manager cannot be woken (paused)", async () => {
    const { companyId, admId, runId } = await seed({ withManager: true, withAdm: true, managerStatus: "paused" });

    await heartbeat.applyRunGuardStop(runId);

    const wakes = await wakesFor(companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: admId });
  });

  it("wakes nobody when there is neither a manager nor an adm", async () => {
    const { companyId, issueId, runId } = await seed({ withManager: false, withAdm: false });

    await heartbeat.applyRunGuardStop(runId);

    expect(await wakesFor(companyId)).toHaveLength(0);
    expect((await issueRow(issueId)).status).toBe("blocked");
  });

  it("does not wake anybody while the call-limit stop is still being continued", async () => {
    const companyIdAndMore = await seed({ withManager: true, withAdm: true });
    const { companyId, issueId, agentId, runId } = companyIdAndMore;
    await db
      .update(heartbeatRuns)
      .set({
        errorCode: "model_call_limit",
        resultJson: {
          runGuardStopReason: "model_call_limit",
          runGuardStats: { toolCalls: 143, writeCalls: 33, readOnlyStreak: 4, modelCalls: 150 },
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "codexcoder", executionLockedAt: STOPPED_AT })
      .where(eq(issues.id, issueId));

    await heartbeat.applyRunGuardStop(runId);

    expect(await wakesFor(companyId)).toHaveLength(0);
    expect((await issueRow(issueId)).status).toBe("in_progress");
    expect((await issueRow(issueId)).assigneeAgentId).toBe(agentId);
  });

  // myrmidon(OPE-12004): the first no_progress_exploration stop gets one automatic retry
  // with a hint, so it is not final and wakes nobody; the stop of that retry is final.
  it("wakes the manager only at the final no_progress_exploration stop, not at the one that is retried", async () => {
    const { companyId, issueId, agentId, managerId, runId } = await seed({ withManager: true });
    await db
      .update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "codexcoder", executionLockedAt: STOPPED_AT })
      .where(eq(issues.id, issueId));

    await heartbeat.applyRunGuardStop(runId);

    expect(await wakesFor(companyId)).toHaveLength(0);
    expect((await issueRow(issueId)).status).toBe("in_progress");
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });

    // The retry runs and is stopped the same way: the ceiling of 1 is spent, the stop is final.
    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        errorCode: "no_progress_exploration",
        resultJson: { runGuardStopReason: "no_progress_exploration", runGuardStats: LOOP_STATS },
        startedAt: STOPPED_AT,
        finishedAt: new Date(STOPPED_AT.getTime() + 5_000),
      })
      .where(eq(heartbeatRuns.id, retry!.id));
    await db.update(issues).set({ checkoutRunId: retry!.id }).where(eq(issues.id, issueId));

    await heartbeat.applyRunGuardStop(retry!.id);

    const wakes = await wakesFor(companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: managerId });
    const issue = await issueRow(issueId);
    expect(issue.status).toBe("blocked");
    expect(issue.assigneeAgentId).toBe(agentId);
  });

  it("accepts only the assignee's reports_to or adm as the recipient the run dispatch lets through", async () => {
    const { companyId, agentId, managerId, admId } = await seed({ withManager: true, withAdm: true });
    const strangerId = await insertAgent({ companyId, name: "Stranger" });
    const recipient = (agent: string) =>
      isRunGuardStopWakeRecipient(db, { companyId, assigneeAgentId: agentId, agentId: agent });

    expect(await recipient(managerId!)).toBe(true);
    expect(await recipient(admId!)).toBe(true);
    expect(await recipient(strangerId)).toBe(false);
    // The assignee is never its own recipient, and a task of adm itself has none.
    expect(await recipient(agentId)).toBe(false);
    expect(await isRunGuardStopWakeRecipient(db, { companyId, assigneeAgentId: admId!, agentId: managerId! })).toBe(false);
    // An agent of another company is not one either.
    const other = await seed({ withManager: true });
    expect(await isRunGuardStopWakeRecipient(db, { companyId, assigneeAgentId: agentId, agentId: other.managerId! })).toBe(false);
  });

  it("wakes nobody when the assignee is adm itself", async () => {
    const { companyId, issueId, runId } = await seed({ withManager: true, withAdm: false, assigneeName: "adm" });

    await heartbeat.applyRunGuardStop(runId);

    expect(await wakesFor(companyId)).toHaveLength(0);
    expect((await issueRow(issueId)).status).toBe("blocked");
  });

  it("does not let the run dispatch start the wake of an agent that is neither the assignee's manager nor adm", async () => {
    const { companyId, issueId, runId } = await seed({ withManager: true });
    await heartbeat.applyRunGuardStop(runId);
    const strangerId = await insertAgent({ companyId, name: "Stranger" });

    const { wake, returned } = await wakeAs(strangerId, issueId);

    // No run starts for the stranger: the wake is refused outright or its run is cancelled as stale.
    expect(returned === null || returned.status === "cancelled").toBe(true);
    expect(wake === undefined || wake.status === "skipped").toBe(true);
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, strangerId));
    expect(runs.every((run) => run.status === "cancelled")).toBe(true);
  });

  it("does not let the run dispatch start the wake of the manager once the issue is no longer blocked", async () => {
    const { issueId, managerId, runId } = await seed({ withManager: true });
    await heartbeat.applyRunGuardStop(runId);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.agentId, managerId!));
    // Set the first wake aside (a delete would hit the run that holds it).
    await db
      .update(agentWakeupRequests)
      .set({ reason: "run_guard_stop_needs_input_first" })
      .where(eq(agentWakeupRequests.reason, RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));

    const { wake } = await wakeAs(managerId!, issueId);
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));
    expect(run?.status).toBe("cancelled");

    expect(wake.status).toBe("skipped");
    expect(wake.error).toContain("issue assignee changed");
  });

  it("wakes the manager when the stranded-issue sweep is the one that blocks the task", async () => {
    const { companyId, issueId, managerId } = await seed({ withManager: true });

    await heartbeat.reconcileStrandedAssignedIssues();

    expect((await issueRow(issueId)).status).toBe("blocked");
    const wakes = await wakesFor(companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: managerId });
    expect(wakes[0]?.payload).toMatchObject({ issueId });
  });
});
