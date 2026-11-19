import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@myrmidon/shared";
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
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.ts";
import { createPgReviewRoutingStore } from "../myrmidon/review-routing/store.js";
import { buildReviewRoutingReassignPatch, readPendingAgentReview } from "../myrmidon/review-routing/policy.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

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
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
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
    seededAgentIds.clear();
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

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review" | "blocked";
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
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
      status: input?.agentStatus ?? "active",
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
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
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
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  it("triggers a due monitor for a blocked issue", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture({ issueStatus: "blocked" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(nextCheckAt);

    expect(result.enqueued).toBe(1);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(nextCheckAt.toISOString());
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({ issueId, nextCheckAt: nextCheckAt.toISOString() });
  });

  it("does not wake the assignee for a due monitor while a human review is pending", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture({ issueStatus: "in_review" });
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: "reviewer" },
        returnAssignee: { type: "agent", agentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    }).where(eq(issues.id, issueId));

    const result = await heartbeatService(db).tickTimers(new Date(nextCheckAt.getTime() + 60_000));

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt?.getTime()).toBe(nextCheckAt.getTime());
  });

  it("routes an ordinary due monitor to the current reviewer, not the return assignee", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture({ issueStatus: "in_review" });
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId, companyId, name: "Reviewer", role: "reviewer", status: "active",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: {},
    });
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const state = {
      status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
      returnAssignee: { type: "agent", agentId, userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      monitor: parseIssueExecutionState(before!.executionState)?.monitor,
    };
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, issueId));

    const previousSecret = process.env.MYRMIDON_AGENT_JWT_SECRET;
    process.env.MYRMIDON_AGENT_JWT_SECRET = "issue-monitor-test-secret";
    const heartbeat = heartbeatService(db);
    try {
      expect((await heartbeat.tickTimers(nextCheckAt)).enqueued).toBe(1);
      expect((await heartbeat.tickTimers(new Date(nextCheckAt.getTime() + 60_000))).enqueued).toBe(0);
      await heartbeat.resumeQueuedRuns();
      await waitForHeartbeatIdle();
    } finally {
      if (previousSecret === undefined) delete process.env.MYRMIDON_AGENT_JWT_SECRET;
      else process.env.MYRMIDON_AGENT_JWT_SECRET = previousSecret;
    }
    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: reviewerId, status: "succeeded" });
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: reviewerId });
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(parseIssueExecutionState(after!.executionState)).toMatchObject({
      currentParticipant: state.currentParticipant, returnAssignee: state.returnAssignee,
    });
  });

  it("preserves a reassigned reviewer when an exhausted monitor is cleared", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture({
      issueStatus: "in_review", monitorAttemptCount: 1, monitor: { maxAttempts: 1 },
    });
    const reviewerId = randomUUID();
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.update(issues).set({ executionState: {
      status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId, userId: null },
      returnAssignee: { type: "agent", agentId, userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      monitor: parseIssueExecutionState(before!.executionState)?.monitor,
    } }).where(eq(issues.id, issueId));
    await db.insert(agents).values({
      id: reviewerId, companyId, name: "New reviewer", role: "reviewer", status: "active",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: {},
    });
    await db.execute(sql.raw(`
      CREATE FUNCTION test_reassign_on_monitor_claim() RETURNS trigger AS $$
      BEGIN
        IF OLD.monitor_wake_requested_at IS NULL AND NEW.monitor_wake_requested_at IS NOT NULL THEN
          UPDATE issues SET execution_state = jsonb_set(execution_state, '{currentParticipant}',
            '{"type":"agent","agentId":"${reviewerId}","userId":null}'::jsonb) WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_reassign_on_monitor_claim AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_reassign_on_monitor_claim();
    `));
    try {
      await heartbeatService(db, { executesRuns: false }).tickTimers(nextCheckAt);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(parseIssueExecutionState(after!.executionState)).toMatchObject({
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId },
        monitor: { status: "cleared" },
      });
    } finally {
      await db.execute(sql.raw("DROP TRIGGER test_reassign_on_monitor_claim ON issues; DROP FUNCTION test_reassign_on_monitor_claim();"));
      await db.delete(heartbeatRuns);
    }
  });

  it("preserves a concurrent reschedule when a review CI monitor has no reviewer", async () => {
    const { issueId, nextCheckAt } = await seedFixture({ monitor: { serviceName: "Review CI wait" } });
    const rescheduledAt = new Date(nextCheckAt.getTime() + 3_600_000);
    await db.execute(sql.raw(`
      CREATE FUNCTION test_reschedule_review_wait() RETURNS trigger AS $$
      BEGIN
        IF OLD.monitor_wake_requested_at IS NULL AND NEW.monitor_wake_requested_at IS NOT NULL THEN
          UPDATE issues SET monitor_next_check_at = '${rescheduledAt.toISOString()}'::timestamptz,
            execution_policy = jsonb_set(execution_policy, '{monitor,nextCheckAt}', to_jsonb('${rescheduledAt.toISOString()}'::text)),
            execution_state = jsonb_set(execution_state, '{monitor,nextCheckAt}', to_jsonb('${rescheduledAt.toISOString()}'::text))
          WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_reschedule_review_wait AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_reschedule_review_wait();
    `));
    try {
      await heartbeatService(db, { executesRuns: false }).tickTimers(nextCheckAt);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after!.monitorNextCheckAt?.toISOString()).toBe(rescheduledAt.toISOString());
      expect(normalizeIssueExecutionPolicy(after!.executionPolicy)?.monitor?.nextCheckAt).toBe(rescheduledAt.toISOString());
    } finally {
      await db.execute(sql.raw("DROP TRIGGER test_reschedule_review_wait ON issues; DROP FUNCTION test_reschedule_review_wait();"));
    }
  });

  it("does not dispatch a stale review claim after the monitor is rescheduled", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture({
      issueStatus: "in_review", monitor: { serviceName: "Review CI wait" },
    });
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.update(issues).set({ executionState: {
      status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId, userId: null },
      returnAssignee: { type: "agent", agentId, userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      monitor: parseIssueExecutionState(before!.executionState)?.monitor,
    } }).where(eq(issues.id, issueId));
    const rescheduledAt = new Date(nextCheckAt.getTime() + 3_600_000);
    await db.execute(sql.raw(`
      CREATE FUNCTION test_reschedule_stale_review_claim() RETURNS trigger AS $$
      BEGIN
        IF OLD.monitor_wake_requested_at IS NULL AND NEW.monitor_wake_requested_at IS NOT NULL THEN
          UPDATE issues SET monitor_next_check_at = '${rescheduledAt.toISOString()}'::timestamptz,
            monitor_wake_requested_at = NULL,
            execution_state = jsonb_set(execution_state, '{monitor,nextCheckAt}', to_jsonb('${rescheduledAt.toISOString()}'::text))
          WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_reschedule_stale_review_claim AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_reschedule_stale_review_claim();
    `));
    try {
      const result = await heartbeatService(db, { executesRuns: false }).tickTimers(nextCheckAt);
      expect(result.enqueued).toBe(0);
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after!.monitorNextCheckAt?.toISOString()).toBe(rescheduledAt.toISOString());
      await db.execute(sql.raw("DROP TRIGGER test_reschedule_stale_review_claim ON issues; DROP FUNCTION test_reschedule_stale_review_claim();"));
      expect((await heartbeatService(db, { executesRuns: false }).tickTimers(rescheduledAt)).enqueued).toBe(1);
      expect((await heartbeatService(db, { executesRuns: false }).tickTimers(rescheduledAt)).enqueued).toBe(0);
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS test_reschedule_stale_review_claim ON issues; DROP FUNCTION IF EXISTS test_reschedule_stale_review_claim();"));
      await db.delete(heartbeatRuns);
    }
  });

  it("does not wake an old claim when new evidence replaces it at the same schedule", async () => {
    const { issueId, nextCheckAt } = await seedFixture();
    const newerClaimAt = new Date(nextCheckAt.getTime() + 60_000);
    await db.execute(sql.raw(`
      CREATE FUNCTION test_replace_claim_with_evidence() RETURNS trigger AS $$
      BEGIN
        IF OLD.monitor_wake_requested_at IS NULL AND NEW.monitor_wake_requested_at IS NOT NULL THEN
          UPDATE issues SET monitor_wake_requested_at = '${newerClaimAt.toISOString()}'::timestamptz,
            monitor_notes = 'new evidence'
          WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_replace_claim_with_evidence AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_replace_claim_with_evidence();
    `));
    try {
      const result = await heartbeatService(db, { executesRuns: false }).tickTimers(nextCheckAt);
      expect(result.enqueued).toBe(0);
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after!.monitorWakeRequestedAt?.toISOString()).toBe(newerClaimAt.toISOString());
      expect(after!.monitorNotes).toBe("new evidence");
    } finally {
      await db.execute(sql.raw("DROP TRIGGER test_replace_claim_with_evidence ON issues; DROP FUNCTION test_replace_claim_with_evidence();"));
      await db.delete(heartbeatRuns);
    }
  });

  it("preserves a concurrent reschedule when an old monitor is deferred for CI", async () => {
    const { companyId, issueId, nextCheckAt } = await seedFixture();
    const rescheduledAt = new Date(nextCheckAt.getTime() + 3_600_000);
    await db.insert(issueWorkProducts).values({
      id: randomUUID(), companyId, issueId, type: "pull_request", provider: "github",
      title: "PR #123", status: "open", metadata: { activeCi: { status: "in_progress" } },
    });
    await db.execute(sql.raw(`
      CREATE FUNCTION test_reschedule_on_claim() RETURNS trigger AS $$
      BEGIN
        IF OLD.monitor_wake_requested_at IS NULL AND NEW.monitor_wake_requested_at IS NOT NULL THEN
          UPDATE issues SET monitor_next_check_at = '${rescheduledAt.toISOString()}'::timestamptz,
            execution_policy = jsonb_set(execution_policy, '{monitor,nextCheckAt}', to_jsonb('${rescheduledAt.toISOString()}'::text)),
            execution_state = jsonb_set(execution_state, '{monitor,nextCheckAt}', to_jsonb('${rescheduledAt.toISOString()}'::text))
          WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_reschedule_on_claim AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_reschedule_on_claim();
    `));
    try {
      await heartbeatService(db, { executesRuns: false }).tickTimers(nextCheckAt);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after!.monitorNextCheckAt?.toISOString()).toBe(rescheduledAt.toISOString());
      expect(normalizeIssueExecutionPolicy(after!.executionPolicy)?.monitor?.nextCheckAt).toBe(rescheduledAt.toISOString());
    } finally {
      await db.execute(sql.raw("DROP TRIGGER test_reschedule_on_claim ON issues; DROP FUNCTION test_reschedule_on_claim();"));
    }
  });

  it("does not release a newer claim when a manual wake fails", async () => {
    const { issueId, nextCheckAt } = await seedFixture({ agentStatus: "paused" });
    const newerClaimAt = new Date(nextCheckAt.getTime() + 60_000);
    await db.execute(sql.raw(`
      CREATE FUNCTION test_replace_manual_monitor_claim() RETURNS trigger AS $$
      BEGIN
        IF OLD.monitor_wake_requested_at IS NULL AND NEW.monitor_wake_requested_at IS NOT NULL THEN
          UPDATE issues SET monitor_wake_requested_at = '${newerClaimAt.toISOString()}'::timestamptz
          WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_replace_manual_monitor_claim AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_replace_manual_monitor_claim();
    `));
    try {
      await expect(heartbeatService(db).triggerIssueMonitor(issueId, {
        now: nextCheckAt, actorType: "user", actorId: "local-board",
      })).rejects.toThrow();
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after!.monitorWakeRequestedAt?.toISOString()).toBe(newerClaimAt.toISOString());
    } finally {
      await db.execute(sql.raw("DROP TRIGGER test_replace_manual_monitor_claim ON issues; DROP FUNCTION test_replace_manual_monitor_claim();"));
    }
  });

  it("preserves a concurrent reschedule when an old monitor cannot wake a paused agent", async () => {
    const { issueId, nextCheckAt } = await seedFixture({ agentStatus: "paused" });
    const rescheduledAt = new Date(nextCheckAt.getTime() + 3_600_000);
    await db.execute(sql.raw(`
      CREATE FUNCTION test_reschedule_before_failed_wake() RETURNS trigger AS $$
      BEGIN
        IF OLD.monitor_wake_requested_at IS NULL AND NEW.monitor_wake_requested_at IS NOT NULL THEN
          UPDATE issues SET monitor_next_check_at = '${rescheduledAt.toISOString()}'::timestamptz,
            execution_policy = jsonb_set(execution_policy, '{monitor,nextCheckAt}', to_jsonb('${rescheduledAt.toISOString()}'::text)),
            execution_state = jsonb_set(execution_state, '{monitor,nextCheckAt}', to_jsonb('${rescheduledAt.toISOString()}'::text))
          WHERE id = NEW.id;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_reschedule_before_failed_wake AFTER UPDATE ON issues
      FOR EACH ROW EXECUTE FUNCTION test_reschedule_before_failed_wake();
    `));
    try {
      await heartbeatService(db, { executesRuns: false }).tickTimers(nextCheckAt);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after!.monitorNextCheckAt?.toISOString()).toBe(rescheduledAt.toISOString());
      expect(normalizeIssueExecutionPolicy(after!.executionPolicy)?.monitor?.nextCheckAt).toBe(rescheduledAt.toISOString());
    } finally {
      await db.execute(sql.raw("DROP TRIGGER test_reschedule_before_failed_wake ON issues; DROP FUNCTION test_reschedule_before_failed_wake();"));
    }
  });

  it("preserves a monitor rescheduled while its previous wake is enqueued", async () => {
    const { issueId, nextCheckAt } = await seedFixture();
    const rescheduledAt = new Date(nextCheckAt.getTime() + 3_600_000);
    await db.execute(sql.raw(`
      CREATE FUNCTION test_reschedule_monitor() RETURNS trigger AS $$
      BEGIN
        UPDATE issues SET monitor_next_check_at = '${rescheduledAt.toISOString()}'::timestamptz,
          execution_policy = jsonb_set(execution_policy, '{monitor,nextCheckAt}', to_jsonb('${rescheduledAt.toISOString()}'::text)),
          execution_state = jsonb_set(execution_state, '{monitor,nextCheckAt}', to_jsonb('${rescheduledAt.toISOString()}'::text))
        WHERE id = '${issueId}'::uuid;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_reschedule_monitor AFTER INSERT ON agent_wakeup_requests
      FOR EACH ROW EXECUTE FUNCTION test_reschedule_monitor();
    `));
    try {
      await heartbeatService(db, { executesRuns: false }).tickTimers(nextCheckAt);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after!.monitorNextCheckAt?.toISOString()).toBe(rescheduledAt.toISOString());
      expect(normalizeIssueExecutionPolicy(after!.executionPolicy)?.monitor?.nextCheckAt).toBe(rescheduledAt.toISOString());
    } finally {
      await db.execute(sql.raw("DROP TRIGGER test_reschedule_monitor ON agent_wakeup_requests; DROP FUNCTION test_reschedule_monitor();"));
      await db.delete(heartbeatRuns);
    }
  });

  it("hands a queued monitor wake to the reviewer selected before admission", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture({ issueStatus: "in_review" });
    const oldReviewer = randomUUID();
    const newReviewer = randomUUID();
    for (const id of [oldReviewer, newReviewer]) {
      await db.insert(agents).values({
        id, companyId, name: `Reviewer ${id}`, role: "reviewer", status: "active",
        adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: {},
      });
    }
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const state = {
      status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: oldReviewer, userId: null },
      returnAssignee: { type: "agent", agentId, userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      monitor: parseIssueExecutionState(before!.executionState)?.monitor,
    };
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, issueId));
    const previousSecret = process.env.MYRMIDON_AGENT_JWT_SECRET;
    process.env.MYRMIDON_AGENT_JWT_SECRET = "issue-monitor-test-secret";
    try {
      const scheduler = heartbeatService(db, { executesRuns: false });
      expect((await scheduler.tickTimers(nextCheckAt)).enqueued).toBe(1);
      const [queued] = await db.select().from(heartbeatRuns);
      expect(queued).toMatchObject({ agentId: oldReviewer, status: "queued" });
      await db.update(issues).set({
        executionState: sql`jsonb_set(${issues.executionState}, '{currentParticipant}', ${JSON.stringify({ type: "agent", agentId: newReviewer, userId: null })}::jsonb)`,
      }).where(eq(issues.id, issueId));
      const executor = heartbeatService(db);
      await executor.resumeQueuedRuns();
      await waitForHeartbeatIdle();
      expect((await executor.tickTimers(new Date(nextCheckAt.getTime() + 60_000))).enqueued).toBe(0);
      const runs = await db.select().from(heartbeatRuns);
      expect(runs.filter((run) => run.status === "succeeded").map((run) => run.agentId)).toEqual([newReviewer]);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(parseIssueExecutionState(after!.executionState)).toMatchObject({
        currentParticipant: { type: "agent", agentId: newReviewer }, returnAssignee: state.returnAssignee,
      });
    } finally {
      if (previousSecret === undefined) delete process.env.MYRMIDON_AGENT_JWT_SECRET;
      else process.env.MYRMIDON_AGENT_JWT_SECRET = previousSecret;
    }
  });

  it("coalesces the routing reassignment wake with a queued monitor handoff", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture({ issueStatus: "in_review" });
    const [oldReviewer, newReviewer, stageId] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [oldReviewer, newReviewer]) {
      await db.insert(agents).values({
        id, companyId, name: `Reviewer ${id}`, role: "reviewer", status: "active",
        adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: {},
      });
    }
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const returnAssignee = { type: "agent", agentId, userId: null };
    await db.update(issues).set({
      assigneeAgentId: oldReviewer,
      executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ type: "agent", agentId: oldReviewer }] }],
        monitor: normalizeIssueExecutionPolicy(before!.executionPolicy)?.monitor },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: oldReviewer, userId: null }, returnAssignee,
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        monitor: parseIssueExecutionState(before!.executionState)?.monitor },
    }).where(eq(issues.id, issueId));
    const previousSecret = process.env.MYRMIDON_AGENT_JWT_SECRET;
    process.env.MYRMIDON_AGENT_JWT_SECRET = "issue-monitor-test-secret";
    try {
      const scheduler = heartbeatService(db, { executesRuns: false });
      expect((await scheduler.tickTimers(nextCheckAt)).enqueued).toBe(1);
      const store = createPgReviewRoutingStore(db);
      const applied = await store.applyPatch({
        issueId, companyId,
        guard: (fresh) => readPendingAgentReview(fresh)?.reviewerAgentId === oldReviewer,
        build: (fresh) => buildReviewRoutingReassignPatch({ issue: fresh, newReviewerAgentId: newReviewer }),
      });
      expect(applied).not.toBeNull();
      await scheduler.wakeup(newReviewer, {
        source: "assignment", triggerDetail: "system", reason: "execution_review_requested",
        payload: { issueId, mutation: "myrmidon_review_routing_reassign", executionStage: applied!.executionState },
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "execution_review_requested", source: "myrmidon.review_routing" },
      });
      const executor = heartbeatService(db);
      await executor.resumeQueuedRuns();
      await waitForHeartbeatSideEffectsSettled();
      expect((await executor.tickTimers(new Date(nextCheckAt.getTime() + 60_000))).enqueued).toBe(0);
      const runs = await db.select().from(heartbeatRuns);
      // The no-op test adapter can trigger the independent missing-comment retry.
      expect(runs.filter((run) => run.agentId === newReviewer && !run.retryOfRunId)).toHaveLength(1);
      expect(runs.filter((run) => run.agentId === newReviewer && !run.retryOfRunId).map((run) => run.status)).toEqual(["succeeded"]);
      const wakes = await db.select().from(agentWakeupRequests);
      expect(wakes.filter((wake) => wake.idempotencyKey?.startsWith("issue-monitor-handoff:"))).toHaveLength(0);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(parseIssueExecutionState(after!.executionState)).toMatchObject({
        currentParticipant: { type: "agent", agentId: newReviewer }, returnAssignee,
      });
    } finally {
      if (previousSecret === undefined) delete process.env.MYRMIDON_AGENT_JWT_SECRET;
      else process.env.MYRMIDON_AGENT_JWT_SECRET = previousSecret;
    }
  });

  it("recovers a monitor handoff after a crash immediately following cancellation", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture({ issueStatus: "in_review" });
    const [oldReviewer, newReviewer] = [randomUUID(), randomUUID()];
    for (const id of [oldReviewer, newReviewer]) {
      await db.insert(agents).values({
        id, companyId, name: `Reviewer ${id}`, role: "reviewer", status: "active",
        adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: {},
      });
    }
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const returnAssignee = { type: "agent", agentId, userId: null };
    await db.update(issues).set({ executionState: {
      status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: oldReviewer, userId: null }, returnAssignee,
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      monitor: parseIssueExecutionState(before!.executionState)?.monitor,
    } }).where(eq(issues.id, issueId));
    const previousSecret = process.env.MYRMIDON_AGENT_JWT_SECRET;
    process.env.MYRMIDON_AGENT_JWT_SECRET = "issue-monitor-test-secret";
    try {
      expect((await heartbeatService(db, { executesRuns: false }).tickTimers(nextCheckAt)).enqueued).toBe(1);
      const [queued] = await db.select().from(heartbeatRuns);
      await db.update(issues).set({
        executionState: sql`jsonb_set(${issues.executionState}, '{currentParticipant}', ${JSON.stringify({ type: "agent", agentId: newReviewer, userId: null })}::jsonb)`,
      }).where(eq(issues.id, issueId));
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        companyId, runId: queued!.id, expectedStatus: "queued", now: new Date(),
      })).toMatchObject({ outcome: "cancelled", errorCode: "issue_review_participant_changed" });
      // Restart after the cancellation transaction but before its post-commit drain.
      const old = new Date(Date.now() - 11 * 60_000);
      await db.update(heartbeatRuns).set({ finishedAt: old }).where(eq(heartbeatRuns.id, queued!.id));
      await db.update(agentWakeupRequests).set({ requestedAt: old, createdAt: old, updatedAt: old })
        .where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
      const executor = heartbeatService(db);
      await executor.resumeQueuedRuns();
      await waitForHeartbeatIdle();
      const runs = await db.select().from(heartbeatRuns);
      expect(runs.filter((run) => run.status === "succeeded").map((run) => run.agentId)).toEqual([newReviewer]);
      expect((await executor.tickTimers(new Date(nextCheckAt.getTime() + 60_000))).enqueued).toBe(0);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(parseIssueExecutionState(after!.executionState)).toMatchObject({
        currentParticipant: { type: "agent", agentId: newReviewer }, returnAssignee,
      });
    } finally {
      if (previousSecret === undefined) delete process.env.MYRMIDON_AGENT_JWT_SECRET;
      else process.env.MYRMIDON_AGENT_JWT_SECRET = previousSecret;
    }
  });

  it("follows a second reviewer change during the durable monitor handoff", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture({ issueStatus: "in_review" });
    const [oldReviewer, intermediateReviewer, finalReviewer] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [oldReviewer, intermediateReviewer, finalReviewer]) {
      await db.insert(agents).values({
        id, companyId, name: `Reviewer ${id}`, role: "reviewer", status: "active",
        adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: {},
      });
    }
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const state = {
      status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: oldReviewer, userId: null },
      returnAssignee: { type: "agent", agentId, userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      monitor: parseIssueExecutionState(before!.executionState)?.monitor,
    };
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, issueId));
    const previousSecret = process.env.MYRMIDON_AGENT_JWT_SECRET;
    process.env.MYRMIDON_AGENT_JWT_SECRET = "issue-monitor-test-secret";
    try {
      const scheduler = heartbeatService(db, { executesRuns: false });
      expect((await scheduler.tickTimers(nextCheckAt)).enqueued).toBe(1);
      await db.update(issues).set({
        executionState: sql`jsonb_set(${issues.executionState}, '{currentParticipant}', ${JSON.stringify({ type: "agent", agentId: intermediateReviewer, userId: null })}::jsonb)`,
      }).where(eq(issues.id, issueId));
      await db.execute(sql.raw(`
        CREATE FUNCTION test_second_review_change() RETURNS trigger AS $$
        BEGIN
          IF NEW.agent_id = '${intermediateReviewer}'::uuid AND NEW.reason = 'issue_monitor_due' THEN
            UPDATE issues SET execution_state = jsonb_set(execution_state, '{currentParticipant}',
              '{"type":"agent","agentId":"${finalReviewer}","userId":null}'::jsonb) WHERE id = '${issueId}'::uuid;
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER test_second_review_change AFTER INSERT ON agent_wakeup_requests
        FOR EACH ROW EXECUTE FUNCTION test_second_review_change();
      `));
      const executor = heartbeatService(db);
      await executor.resumeQueuedRuns();
      await waitForHeartbeatIdle();
      expect((await executor.tickTimers(new Date(nextCheckAt.getTime() + 60_000))).enqueued).toBe(0);
      const runs = await db.select().from(heartbeatRuns);
      expect(runs.filter((run) => run.status === "succeeded").map((run) => run.agentId)).toEqual([finalReviewer]);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(parseIssueExecutionState(after!.executionState)).toMatchObject({
        currentParticipant: { type: "agent", agentId: finalReviewer }, returnAssignee: state.returnAssignee,
      });
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS test_second_review_change ON agent_wakeup_requests; DROP FUNCTION IF EXISTS test_second_review_change();"));
      if (previousSecret === undefined) delete process.env.MYRMIDON_AGENT_JWT_SECRET;
      else process.env.MYRMIDON_AGENT_JWT_SECRET = previousSecret;
    }
  });

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  it("does not wake the agent when CI is in progress and defers next check with backoff", async () => {
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { notes: "Waiting for CI to finish" },
    });
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "PR #123",
      status: "open",
      metadata: {
        repository: "paperclipai/paperclip",
        number: 123,
        activeCi: {
          repository: "paperclipai/paperclip",
          number: 123,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          status: "in_progress",
          runId: "456",
        },
      },
    });

    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeatService(db).tickTimers(tickAt);
    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated.monitorNextCheckAt).not.toBeNull();
    expect(new Date(updated.monitorNextCheckAt!).getTime()).toBeGreaterThan(tickAt.getTime());
    expect(updated.monitorAttemptCount).toBe(1);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_deferred");
  });

  it.each(["unknown", "exhausted"] as const)("does not replay a quota monitor with %s execution evidence", async (kind) => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      scheduledRetryAttempt: kind === "exhausted" ? 2 : 0,
      resultJson: kind === "exhausted" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toMatchObject([{ ownerType: "board", evidence: { runId: sourceRunId } }]);
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
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
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: participantAgentId, status: "failed",
      errorCode: "provider_quota", finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(scheduled).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(await heartbeat.promoteDueScheduledRetries(scheduled.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(2);
    expect(participantRuns.find((run) => run.id === scheduled.id)?.errorCode).not.toBe("issue_assignee_changed");
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("clears exhausted monitors without waking the owner and leaves one note (EMPTY-RUNS-MONITOR)", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    // myrmidon(EMPTY-RUNS-MONITOR): the owner is not woken for an exhausted monitor; one note says why.
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toHaveLength(0);
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain("исчерпан предел попыток");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).not.toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: null,
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });
});
