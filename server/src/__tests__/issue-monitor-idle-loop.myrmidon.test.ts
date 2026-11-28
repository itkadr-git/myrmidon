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
import { readIssueMonitorSnapshotHash } from "../myrmidon/issue-monitor-idle/store.ts";

// myrmidon(MONITOR-IDLE-LOOP, OPE-13141): a due monitor of a task that waits for
// its subtasks does not wake a model while nothing changed; after three unchanged
// terms the monitor is removed and the removal is written to the activity log.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres idle-loop monitor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function at(hhmm: string): Date {
  return new Date(`2026-04-11T${hhmm}:00.000Z`);
}

describeEmbeddedPostgres("issue monitor that waits for subtasks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-idle-loop-monitor-");
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
    throw new Error("Timed out waiting for idle-loop monitor heartbeat side effects to settle");
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

  const OWNER_NOTES = "Wait for the subtasks to land";

  /** An epic owned by a lead, one subtask in progress, the epic's monitor due. */
  async function seedEpic(input?: { withChild?: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const epicId = randomUUID();
    const childId = randomUUID();
    const issuePrefix = `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
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
      name: "Lead Bot",
      role: "lead",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: epicId,
      companyId,
      title: "Epic",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    if (input?.withChild !== false) {
      await db.insert(issues).values({
        id: childId,
        companyId,
        parentId: epicId,
        title: "Subtask",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      });
      await db.insert(issueWorkProducts).values({
        id: randomUUID(),
        companyId,
        issueId: childId,
        type: "pull_request",
        provider: "github",
        title: "PR #11",
        status: "open",
        metadata: { repository: "company-a/example.com", number: 11, headSha: HEAD },
      });
    }
    return { companyId, agentId, epicId, childId };
  }

  /** The owner arms the monitor again: due at `dueAt`, as after the agent's own re-arm. */
  async function armMonitor(epicId: string, dueAt: Date) {
    const monitor = {
      nextCheckAt: dueAt.toISOString(),
      notes: OWNER_NOTES,
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: "Subtasks",
    };
    await db
      .update(issues)
      .set({
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
            nextCheckAt: dueAt.toISOString(),
            lastTriggeredAt: null,
            attemptCount: 0,
            notes: OWNER_NOTES,
            scheduledBy: "assignee",
            serviceName: "Subtasks",
            externalRef: null,
            timeoutAt: null,
            maxAttempts: null,
            recoveryPolicy: null,
            clearedAt: null,
            clearReason: null,
          },
        },
        monitorNextCheckAt: dueAt,
        monitorAttemptCount: 0,
        monitorNotes: OWNER_NOTES,
        monitorScheduledBy: "assignee",
        monitorWakeRequestedAt: null,
      })
      .where(eq(issues.id, epicId));
  }

  /** The wake the owner was last given recorded this snapshot of the epic. */
  async function recordWake(companyId: string, epicId: string, agentId: string) {
    const snapshotHash = await readIssueMonitorSnapshotHash(db, { companyId, issueId: epicId, ownerAgentId: agentId });
    expect(snapshotHash).not.toBeNull();
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "heartbeat_scheduler",
      action: "issue.monitor_triggered",
      entityType: "issue",
      entityId: epicId,
      details: { snapshotHash, unchangedCount: 0 },
    });
    return snapshotHash as string;
  }

  async function activityActions(epicId: string, action: string) {
    return (await db.select().from(activityLog).where(eq(activityLog.entityId, epicId))).filter(
      (row) => row.action === action,
    );
  }

  it("keeps the model asleep while the subtasks do not change, then removes the monitor after three terms", async () => {
    const { companyId, agentId, epicId } = await seedEpic();
    await recordWake(companyId, epicId, agentId);
    const heartbeat = heartbeatService(db);

    // Term 1 and 2: no wake, the monitor moves on with a growing interval.
    await armMonitor(epicId, at("12:30"));
    expect((await heartbeat.tickTimers(at("12:31"))).enqueued).toBe(0);
    let [epic] = await db.select().from(issues).where(eq(issues.id, epicId));
    expect(epic.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T12:41:00.000Z");
    expect(epic.monitorWakeRequestedAt).toBeNull();

    await armMonitor(epicId, at("13:30"));
    expect((await heartbeat.tickTimers(at("13:31"))).enqueued).toBe(0);
    [epic] = await db.select().from(issues).where(eq(issues.id, epicId));
    expect(epic.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T13:51:00.000Z");

    const deferred = await activityActions(epicId, "issue.monitor_deferred");
    expect(deferred.map((row) => (row.details as Record<string, unknown>).unchangedCount).sort()).toEqual([1, 2]);
    expect(deferred[0]?.details).toMatchObject({ reason: "issue_state_unchanged" });

    // Term 3: the monitor is removed and the removal is written to the activity log.
    await armMonitor(epicId, at("14:30"));
    expect((await heartbeat.tickTimers(at("14:31"))).enqueued).toBe(0);
    [epic] = await db.select().from(issues).where(eq(issues.id, epicId));
    expect(epic.monitorNextCheckAt).toBeNull();
    expect(epic.monitorWakeRequestedAt).toBeNull();
    const cleared = await activityActions(epicId, "issue.monitor_cleared");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.details).toMatchObject({ reason: "unchanged_wake_limit", unchangedCount: 3 });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("does not defer a replacement monitor using an old unchanged snapshot", async () => {
    const { companyId, agentId, epicId, childId } = await seedEpic();
    await recordWake(companyId, epicId, agentId);
    await armMonitor(epicId, at("12:30"));
    await db.execute(sql.raw(`
      CREATE FUNCTION test_replace_idle_monitor() RETURNS trigger AS $$
      BEGIN
        IF OLD.monitor_wake_requested_at IS NULL AND NEW.monitor_wake_requested_at IS NOT NULL THEN
          UPDATE issues SET monitor_next_check_at = '2026-04-11T13:30:00Z'::timestamptz,
            monitor_wake_requested_at = NULL, monitor_notes = 'replacement evidence'
          WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_replace_idle_monitor AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_replace_idle_monitor();
    `));
    try {
      expect((await heartbeatService(db, { executesRuns: false }).tickTimers(at("12:31"))).enqueued).toBe(0);
      const [epic] = await db.select().from(issues).where(eq(issues.id, epicId));
      expect(epic.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T13:30:00.000Z");
      expect(epic.monitorNotes).toBe("replacement evidence");
      expect(await activityActions(epicId, "issue.monitor_deferred")).toHaveLength(0);
      await db.execute(sql.raw("DROP TRIGGER test_replace_idle_monitor ON issues; DROP FUNCTION test_replace_idle_monitor();"));
      await db.insert(issueComments).values({ companyId, issueId: childId, authorUserId: "user-1", body: "New evidence" });
      const heartbeat = heartbeatService(db, { executesRuns: false });
      expect((await heartbeat.tickTimers(at("13:31"))).enqueued).toBe(1);
      expect((await heartbeat.tickTimers(at("13:31"))).enqueued).toBe(0);
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
      await db.delete(heartbeatRuns);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS test_replace_idle_monitor ON issues; DROP FUNCTION IF EXISTS test_replace_idle_monitor();"));
    }
  });

  it("does not clear a replacement monitor after an old unchanged snapshot reaches its limit", async () => {
    const { companyId, agentId, epicId } = await seedEpic();
    await recordWake(companyId, epicId, agentId);
    const heartbeat = heartbeatService(db, { executesRuns: false });
    await armMonitor(epicId, at("12:30"));
    await heartbeat.tickTimers(at("12:31"));
    await armMonitor(epicId, at("13:30"));
    await heartbeat.tickTimers(at("13:31"));
    await armMonitor(epicId, at("14:30"));
    await db.execute(sql.raw(`
      CREATE FUNCTION test_replace_idle_clear() RETURNS trigger AS $$
      BEGIN
        IF OLD.monitor_wake_requested_at IS NULL AND NEW.monitor_wake_requested_at IS NOT NULL THEN
          UPDATE issues SET monitor_next_check_at = '2026-04-11T15:30:00Z'::timestamptz,
            monitor_wake_requested_at = NULL, monitor_notes = 'new evidence'
          WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_replace_idle_clear AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_replace_idle_clear();
    `));
    try {
      expect((await heartbeat.tickTimers(at("14:31"))).enqueued).toBe(0);
      const [epic] = await db.select().from(issues).where(eq(issues.id, epicId));
      expect(epic.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T15:30:00.000Z");
      expect(epic.monitorNotes).toBe("new evidence");
      expect(await activityActions(epicId, "issue.monitor_cleared")).toHaveLength(0);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS test_replace_idle_clear ON issues; DROP FUNCTION IF EXISTS test_replace_idle_clear();"));
    }
  });

  it("wakes the owner at the first term when it has no recorded wake, and records the snapshot", async () => {
    const { agentId, epicId } = await seedEpic();
    await armMonitor(epicId, at("12:30"));

    const result = await heartbeatService(db).tickTimers(at("12:31"));

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.map((row) => row.reason)).toEqual(["issue_monitor_due"]);
    const triggered = await activityActions(epicId, "issue.monitor_triggered");
    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.details).toMatchObject({ unchangedCount: 0 });
    expect((triggered[0]?.details as Record<string, unknown>).snapshotHash).toEqual(expect.any(String));
    await waitForHeartbeatSideEffectsSettled();
  });

  it("wakes the owner when a subtask changed since the last wake", async () => {
    const { companyId, agentId, epicId, childId } = await seedEpic();
    await recordWake(companyId, epicId, agentId);
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: childId,
      authorUserId: "user-1",
      body: "Review found a problem in the subtask",
    });
    await armMonitor(epicId, at("12:30"));

    const result = await heartbeatService(db).tickTimers(at("12:31"));

    expect(result.enqueued).toBe(1);
    expect(await activityActions(epicId, "issue.monitor_deferred")).toHaveLength(0);
    await waitForHeartbeatSideEffectsSettled();
  });

  it("wakes the owner when a subtask's pull request changed head", async () => {
    const { companyId, agentId, epicId, childId } = await seedEpic();
    await recordWake(companyId, epicId, agentId);
    await db
      .update(issueWorkProducts)
      .set({ metadata: { repository: "company-a/example.com", number: 11, headSha: "f".repeat(40) } })
      .where(eq(issueWorkProducts.issueId, childId));
    await armMonitor(epicId, at("12:30"));

    expect((await heartbeatService(db).tickTimers(at("12:31"))).enqueued).toBe(1);
    await waitForHeartbeatSideEffectsSettled();
  });

  it("does not count the owner's own comments as a change", async () => {
    const { companyId, agentId, epicId } = await seedEpic();
    await recordWake(companyId, epicId, agentId);
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: epicId,
      authorAgentId: agentId,
      body: "Still waiting for the subtasks",
    });
    await armMonitor(epicId, at("12:30"));

    expect((await heartbeatService(db).tickTimers(at("12:31"))).enqueued).toBe(0);
    expect(await activityActions(epicId, "issue.monitor_deferred")).toHaveLength(1);
  });

  it("leaves a monitor of a task without subtasks alone", async () => {
    const { epicId } = await seedEpic({ withChild: false });
    await armMonitor(epicId, at("12:30"));

    expect((await heartbeatService(db).tickTimers(at("12:31"))).enqueued).toBe(1);
    expect(await activityActions(epicId, "issue.monitor_deferred")).toHaveLength(0);
    await waitForHeartbeatSideEffectsSettled();
  });

  it("does not suppress a manual trigger", async () => {
    const { companyId, agentId, epicId } = await seedEpic();
    await recordWake(companyId, epicId, agentId);
    await armMonitor(epicId, at("12:30"));

    await heartbeatService(db).triggerIssueMonitor(epicId, { now: at("12:31") });

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    await waitForHeartbeatSideEffectsSettled();
  });
});
