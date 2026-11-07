// myrmidon(RUN-GUARD-ESCALATE): a task the run guard stopped for good (blocked
// with "a new input is needed") wakes the assignee's manager with the wake reason
// `run_guard_stop_needs_input`: reports_to, else the agent `adm`, else nobody. The
// assignee and the blocked status stay as the escalation set them. One wake per
// issue per 30 minutes.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
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
  RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON,
  hasRecentRunGuardStopWake,
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
  async function seed(input: { withManager: boolean; withAdm?: boolean; managerStatus?: "idle" | "paused" }) {
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
    const agentId = await insertAgent({ companyId, name: "CodexCoder", reportsTo: managerId });
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

  it("does not wake the manager a second time within 30 minutes, and does again after them", async () => {
    const { companyId, issueId, agentId, managerId, runId } = await seed({ withManager: true });
    await heartbeat.applyRunGuardStop(runId);
    expect(await wakesFor(companyId)).toHaveLength(1);

    // The manager put the task back; five minutes later it is stopped again.
    const [first] = await wakesFor(companyId);
    await db
      .update(agentWakeupRequests)
      .set({ requestedAt: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(agentWakeupRequests.id, first!.id));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const secondRunId = await insertStoppedRun({ companyId, agentId, issueId, reason: "repeated_tool_call" });

    await heartbeat.applyRunGuardStop(secondRunId);

    expect(await wakesFor(companyId)).toHaveLength(1);
    // The issue is blocked again all the same: only the wake is held back.
    expect((await issueRow(issueId)).status).toBe("blocked");

    // The window is 30 minutes: 29 still holds the wake back, 31 lets it through.
    const holds = (minutesAgo: number) =>
      db
        .update(agentWakeupRequests)
        .set({ requestedAt: new Date(Date.now() - minutesAgo * 60 * 1000) })
        .where(eq(agentWakeupRequests.id, first!.id))
        .then(() => hasRecentRunGuardStopWake(db, { companyId, issueId }));
    expect(await holds(29)).toBe(true);
    expect(await holds(31)).toBe(false);

    // And after the window a new stop wakes the manager again (the manager's earlier run is over).
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, managerId!), eq(heartbeatRuns.status, "running")));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const thirdRunId = await insertStoppedRun({ companyId, agentId, issueId, reason: "tool_retry_loop" });

    await heartbeat.applyRunGuardStop(thirdRunId);

    const wakes = await wakesFor(companyId);
    expect(wakes).toHaveLength(2);
    expect(wakes.every((wake) => wake.agentId === managerId)).toBe(true);
  });

  it("wakes the agent named adm when the assignee reports to nobody", async () => {
    const { companyId, issueId, admId, runId } = await seed({ withManager: false, withAdm: true });

    await heartbeat.applyRunGuardStop(runId);

    const wakes = await wakesFor(companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: admId });
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
