import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueDocuments,
  issues,
  issueWorkProducts,
  workspaceRuntimeServices,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { parseIssueExecutionState } from "../services/issue-execution-policy.ts";

// myrmidon(PR-WAIT-MONITOR, OPE-11949): a due monitor that waits for a pull
// request is evaluated by the board; the agent is woken only for news.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR-wait monitor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const DUE_AT = new Date("2026-04-11T12:30:00.000Z");
const TICK_AT = new Date("2026-04-11T12:31:00.000Z");

function at(hhmm: string): Date {
  return new Date(`2026-04-11T${hhmm}:00.000Z`);
}

describeEmbeddedPostgres("issue monitor that waits for a pull request", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-wait-monitor-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);
    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for PR-wait monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(issueWorkProducts);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * A task assigned to one agent with a due monitor, one open pull request,
   * and (optionally) the end of the agent's last run on the task.
   */
  async function seed(input?: {
    issueStatus?: string;
    unassigned?: boolean;
    monitor?: { serviceName: string | null; notes: string | null };
    withPullRequest?: boolean;
    pullRequestMetadata?: Record<string, unknown>;
    agentLastRunFinishedAt?: Date | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const serviceName = input?.monitor ? input.monitor.serviceName : "CI";
    const notes = input?.monitor ? input.monitor.notes : "GitHub CI pending monitor";
    const monitor = {
      nextCheckAt: DUE_AT.toISOString(),
      notes,
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName,
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Land the change",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input?.unassigned ? null : agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: DUE_AT.toISOString(),
          lastTriggeredAt: null,
          attemptCount: 0,
          notes,
          scheduledBy: "assignee",
          serviceName,
          externalRef: null,
          timeoutAt: null,
          maxAttempts: null,
          recoveryPolicy: null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: DUE_AT,
      monitorAttemptCount: 0,
      monitorNotes: notes,
      monitorScheduledBy: "assignee",
    });
    if (input?.withPullRequest !== false) {
      await db.insert(issueWorkProducts).values({
        id: randomUUID(),
        companyId,
        issueId,
        type: "pull_request",
        provider: "github",
        title: "PR #7",
        status: "open",
        updatedAt: at("11:00"),
        metadata: {
          repository: "company-a/example.com",
          number: 7,
          headSha: HEAD,
          ...(input?.pullRequestMetadata ?? {}),
        },
      });
    }
    if (input?.agentLastRunFinishedAt) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date(input.agentLastRunFinishedAt.getTime() - 60_000),
        finishedAt: input.agentLastRunFinishedAt,
        contextSnapshot: { issueId },
      });
    }
    return { companyId, agentId, issueId };
  }

  async function activityOf(issueId: string) {
    return db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
  }

  it("does not wake the agent while nothing changed and re-arms the monitor with a growing interval", async () => {
    const { issueId } = await seed({ agentLastRunFinishedAt: at("12:21") });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    // The agent last looked 10 minutes ago: the next silent check is 10 minutes away.
    expect(issue.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T12:41:00.000Z");
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(issue.monitorLastTriggeredAt).toBeNull();
    const deferred = (await activityOf(issueId)).filter((row) => row.action === "issue.monitor_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.details).toMatchObject({ reason: "pr_wait_unchanged", ciState: "unknown", attemptCount: 1 });
  });

  it("keeps the agent asleep when CI finished before the agent last looked", async () => {
    const { issueId } = await seed({
      agentLastRunFinishedAt: at("12:21"),
      pullRequestMetadata: { lastCompletedCi: { conclusion: "success", headSha: HEAD, completedAt: at("12:10").toISOString() } },
    });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt?.getTime()).toBeGreaterThan(TICK_AT.getTime());
  });

  // myrmidon(EMPTY-RUNS-4): the wait for a review or a merge. CI of the head
  // finished and the agent saw it an hour ago; the 30-minute "no signal" wake of
  // a pull request without check data must not start a run here.
  it("keeps the agent asleep past the 30-minute safety period once CI of the head finished and the agent saw it", async () => {
    const { issueId } = await seed({
      monitor: { serviceName: "GitHub PR merge", notes: "Merge-watch: close the task once PR #7 is merged" },
      agentLastRunFinishedAt: at("11:31"),
      pullRequestMetadata: { lastCompletedCi: { conclusion: "success", headSha: HEAD, completedAt: at("11:20").toISOString() } },
    });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    // The agent last looked 60 minutes ago: the silent interval is at its 60-minute cap.
    expect(issue.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T13:31:00.000Z");
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(issue.monitorLastTriggeredAt).toBeNull();
    const deferred = (await activityOf(issueId)).filter((row) => row.action === "issue.monitor_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.details).toMatchObject({ reason: "pr_wait_unchanged", ciState: "settled", attemptCount: 1 });
  });

  it("wakes the agent when CI completed after it last looked and hands over the change", async () => {
    const { issueId, agentId } = await seed({
      agentLastRunFinishedAt: at("12:21"),
      pullRequestMetadata: { lastCompletedCi: { conclusion: "failure", headSha: HEAD, runId: "99", completedAt: at("12:25").toISOString() } },
    });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(1);
    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      observedChange: {
        kind: "state_changed",
        signals: [expect.objectContaining({ kind: "ci_completed", conclusion: "failure", headSha: HEAD })],
      },
    });
    expect((wakeup?.payload as Record<string, unknown>).observedChangeSummary).toContain("failure");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(TICK_AT.toISOString());
  });

  it("wakes the agent when the pull request was merged after it last looked", async () => {
    const { companyId, issueId, agentId } = await seed({ agentLastRunFinishedAt: at("12:21") });
    await db
      .update(issueWorkProducts)
      .set({ status: "merged", updatedAt: at("12:28") })
      .where(eq(issueWorkProducts.companyId, companyId));

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(1);
    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeup?.payload).toMatchObject({
      issueId,
      observedChange: { signals: [expect.objectContaining({ kind: "pr_merged" })] },
    });
  });

  it("wakes the agent once with a no-signal note when the board saw nothing for 30 minutes", async () => {
    const { agentId } = await seed({ agentLastRunFinishedAt: at("12:01") });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(1);
    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeup?.payload).toMatchObject({ observedChange: { kind: "no_signal", signals: [] } });
  });

  it("lets a person trigger the monitor immediately even when nothing changed", async () => {
    const { issueId } = await seed({ agentLastRunFinishedAt: at("12:21") });

    const result = await heartbeatService(db).triggerIssueMonitor(issueId, {
      now: TICK_AT,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("keeps waking for a monitor that does not wait for a pull request", async () => {
    await seed({
      agentLastRunFinishedAt: at("12:21"),
      monitor: { serviceName: "deploy-verifier", notes: "Check deploy" },
    });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(1);
  });

  it.each([
    ["backlog", "invalid_status"],
    ["todo", "invalid_status"],
    ["done", "done"],
    ["cancelled", "cancelled"],
  ] as const)("drops a due monitor of a %s task without waking anyone", async (issueStatus, clearReason) => {
    const { issueId } = await seed({ issueStatus, agentLastRunFinishedAt: at("12:21") });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({ status: "cleared", clearReason });
    const cleared = (await activityOf(issueId)).filter((row) => row.action === "issue.monitor_cleared");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.details).toMatchObject({ reason: clearReason });
  });

  it("drops a due monitor of a task that is not assigned to an agent", async () => {
    const { issueId } = await seed({ unassigned: true, agentLastRunFinishedAt: at("12:21") });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "invalid_assignee",
    });
  });
});
