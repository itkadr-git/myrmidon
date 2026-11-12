import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import type { Db, EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { parseIssueExecutionState } from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stuck triggered monitor sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// OPE-12725: after a monitor fires, `buildIssueMonitorTriggeredPatch` strips the
// policy monitor and nulls `monitorNextCheckAt`. If the woken run dies silently
// nothing ever re-checks: the issue sits with `execution_state.monitor.status =
// "triggered"`, an expired `timeoutAt`, and no timer. The sweep in
// `tickDueIssueMonitors` must close such monitors (or re-arm them while the
// timeout is still in the future) so "triggered and silent" is impossible.
describeEmbeddedPostgres("stuck triggered issue monitor sweep", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function cleanupRows() {
    // The ticks wake the assignee, and the woken runs execute in the background
    // (they write run events and company skills). Wait for them, or their writes
    // race the deletes below: a company_skills row inserted after its delete
    // breaks the delete of companies.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
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
    await cleanupRows();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Seeds the post-trigger shape directly: policy monitor stripped (or the
  // whole policy absent = orphaned), `monitorNextCheckAt` null, and
  // `execution_state.monitor` frozen at "triggered".
  async function seedTriggeredFixture(input?: {
    withPolicy?: boolean;
    issueStatus?: "in_progress" | "in_review" | "blocked" | "done";
    timeoutAt?: string | null;
    lastTriggeredAt?: string;
  }): Promise<{
    companyId: string;
    agentId: string;
    issueId: string;
    lastTriggeredAt: string;
  }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const lastTriggeredAt = input?.lastTriggeredAt ?? "2026-04-11T12:00:00.000Z";
    const timeoutAt = input?.timeoutAt === undefined ? "2026-04-11T12:05:00.000Z" : input?.timeoutAt;

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
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: input?.withPolicy === false
        ? null
        : {
            mode: "normal",
            commentRequired: true,
            stages: [],
          },
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
          status: "triggered",
          nextCheckAt: null,
          lastTriggeredAt,
          attemptCount: 1,
          notes: "Check deploy",
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: "github-actions",
          externalRef: null,
          timeoutAt,
          maxAttempts: 3,
          recoveryPolicy: "wake_owner",
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: new Date(lastTriggeredAt),
      monitorAttemptCount: 1,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, lastTriggeredAt };
  }

  it("closes an expired triggered monitor and wakes the assignee", async () => {
    const { issueId, agentId } = await seedTriggeredFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:30:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
      clearedAt: tickAt.toISOString(),
      serviceName: "github-actions",
      timeoutAt: "2026-04-11T12:05:00.000Z",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_timeout");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "timeout_exceeded",
      serviceName: "github-actions",
      timeoutAt: "2026-04-11T12:05:00.000Z",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_timeout_swept");
  });

  it("sweeps an orphaned triggered monitor with no execution policy", async () => {
    const { issueId, agentId } = await seedTriggeredFixture({ withPolicy: false });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:30:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.executionPolicy).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_timeout");
  });

  it("re-arms a next check for a stale triggered monitor whose timeout is still ahead", async () => {
    const { issueId } = await seedTriggeredFixture({
      lastTriggeredAt: "2026-04-11T12:00:00.000Z",
      timeoutAt: "2026-04-11T13:00:00.000Z",
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:30:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    // No wake: the monitor is not expired, it just needs a timer again.
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
    });
    expect(issue.monitorNextCheckAt).not.toBeNull();
    expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(tickAt.getTime());
    expect(issue.monitorNextCheckAt!.getTime()).toBeLessThanOrEqual(new Date("2026-04-11T13:00:00.000Z").getTime());
  });

  it("leaves a fresh triggered monitor alone before the grace period ends", async () => {
    const { issueId } = await seedTriggeredFixture({
      lastTriggeredAt: "2026-04-11T12:29:00.000Z",
      timeoutAt: "2026-04-11T12:05:00.000Z",
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:30:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      clearReason: null,
    });
    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).not.toContain("issue.monitor_timeout_swept");
  });

  it("sweeps each stuck monitor once even across repeated ticks", async () => {
    const { issueId, agentId } = await seedTriggeredFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:30:00.000Z");

    await heartbeat.tickTimers(tickAt);
    await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity.filter((action) => action === "issue.monitor_timeout_swept")).toHaveLength(1);
    expect(parseIssueExecutionState(
      (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionState,
    )?.monitor).toMatchObject({ status: "cleared", clearReason: "timeout_exceeded" });
  });

  it("does not sweep a triggered monitor whose issue left the active set", async () => {
    const { issueId } = await seedTriggeredFixture({ issueStatus: "done" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:30:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
    });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(issue.monitorNextCheckAt).toBeNull();
  });

  it("leaves the regular scheduled-monitor tick untouched while the sweep runs", async () => {
    // A healthy scheduled monitor (due now) must still dispatch normally even
    // when an unrelated stuck triggered monitor exists on another issue.
    const stuck = await seedTriggeredFixture();
    const healthyIssueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const company = await db.select().from(companies).where(eq(companies.id, stuck.companyId)).then((rows) => rows[0]!);

    await db.insert(issues).values({
      id: healthyIssueId,
      companyId: stuck.companyId,
      title: "Healthy watch",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: stuck.agentId,
      issueNumber: 2,
      identifier: `${company.issuePrefix}-2`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: {
          nextCheckAt: nextCheckAt.toISOString(),
          notes: "Healthy check",
          scheduledBy: "assignee",
        },
      },
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
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: 0,
          notes: "Healthy check",
          scheduledBy: "assignee",
          serviceName: null,
          externalRef: null,
          timeoutAt: null,
          maxAttempts: null,
          recoveryPolicy: null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount: 0,
      monitorNotes: "Healthy check",
      monitorScheduledBy: "assignee",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.tickTimers(nextCheckAt);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, stuck.agentId));
    // One wake from the stuck sweep (timeout) + one from the healthy due
    // monitor dispatch.
    const timeoutWakes = wakeups.filter((wake) => wake.reason === "issue_monitor_timeout");
    const dueWakes = wakeups.filter((wake) => wake.reason === "issue_monitor_due");
    expect(timeoutWakes).toHaveLength(1);
    expect(dueWakes).toHaveLength(1);
    expect(parseIssueExecutionState(
      (await db.select().from(issues).where(eq(issues.id, stuck.issueId)))[0]!.executionState,
    )?.monitor).toMatchObject({ status: "cleared", clearReason: "timeout_exceeded" });
    expect(parseIssueExecutionState(
      (await db.select().from(issues).where(eq(issues.id, healthyIssueId)))[0]!.executionState,
    )?.monitor).toMatchObject({ status: "triggered", lastTriggeredAt: nextCheckAt.toISOString() });
  });
});
