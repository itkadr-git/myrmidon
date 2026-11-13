import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  REVIEW_CI_WAIT_INTERVAL_MS,
  REVIEW_CI_WAIT_MONITOR_SERVICE_NAME,
} from "../myrmidon/review-stage-recovery/policy.ts";

// myrmidon(EMPTY-RUNS-2B): the tick of the board's "Review CI wait" monitor
// applies the green-head rule of the hand-off (OPE-12176). A finished red head
// used to wake the reviewer ten minutes after the hand-off had refused to;
// the reviewer of a head that is red because main is red could only return
// the task, and the executor then ran to find nothing to fix. The suite
// follows issue-monitor-pr-wait.myrmidon.test.ts; the two GitHub reads of the
// tick are replaced, nothing here touches the network. Only the ticks that
// keep the reviewer asleep are run against the database: a tick that wakes
// starts a reviewer run and the stage recovery after it, and those decisions
// (green head, spent budget, critical issue) are covered by the pure tests of
// `decideReviewCiWaitTick` in review-stage-recovery/policy.myrmidon.test.ts.

const mockReviewCi = vi.hoisted(() => ({
  resolveCi: vi.fn(),
  resolveHeadFailedChecks: vi.fn(),
}));

vi.mock("../myrmidon/review-stage-recovery/github-ci.js", async () => {
  const actual = await vi.importActual<typeof import("../myrmidon/review-stage-recovery/github-ci.js")>(
    "../myrmidon/review-stage-recovery/github-ci.js",
  );
  return {
    ...actual,
    createReviewPullRequestCiResolver: () => mockReviewCi.resolveCi,
    createReviewHeadFailedChecksResolver: () => mockReviewCi.resolveHeadFailedChecks,
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review CI wait monitor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const PR_URL = "https://github.com/company-a/example.com/pull/7";
const DUE_AT = new Date("2026-04-11T12:30:00.000Z");
const TICK_AT = new Date("2026-04-11T12:31:00.000Z");

describeEmbeddedPostgres("issue monitor that waits for the CI of a review (Review CI wait)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-ci-wait-monitor-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    mockReviewCi.resolveCi.mockReset();
    mockReviewCi.resolveHeadFailedChecks.mockReset();
    mockReviewCi.resolveHeadFailedChecks.mockResolvedValue({
      state: "ok",
      headSha: HEAD,
      pullRequestUrl: PR_URL,
      failed: [],
    });
  });

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
    throw new Error("Timed out waiting for review CI wait monitor heartbeat side effects to settle");
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
   * A task handed over to review whose reviewer admission was deferred: the
   * issue is `in_review`, the review stage is pending on the reviewer, and the
   * board's "Review CI wait" monitor is due.
   */
  async function seed() {
    const companyId = randomUUID();
    const engineerId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const notes = `Review waits for CI on the head of ${PR_URL} (${HEAD.slice(0, 12)}); CI state=pending.`;
    const attemptCount = 0;
    const monitor = {
      nextCheckAt: DUE_AT.toISOString(),
      notes,
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME,
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    for (const [id, name] of [
      [engineerId, "Engineer Bot"],
      [reviewerId, "Reviewer Bot"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Land the change",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor },
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId: engineerId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: DUE_AT.toISOString(),
          lastTriggeredAt: null,
          attemptCount,
          notes,
          scheduledBy: "assignee",
          serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME,
          externalRef: null,
          timeoutAt: null,
          maxAttempts: null,
          recoveryPolicy: null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: DUE_AT,
      monitorAttemptCount: attemptCount,
      monitorNotes: notes,
      monitorScheduledBy: "assignee",
    });
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "PR #7",
      status: "open",
      url: PR_URL,
      metadata: { repository: "company-a/example.com", number: 7, headSha: HEAD },
    });
    return { companyId, engineerId, reviewerId, issueId };
  }

  function headCi(overrides: Record<string, unknown>) {
    mockReviewCi.resolveCi.mockResolvedValue({
      state: "complete",
      pullRequestUrl: PR_URL,
      headSha: HEAD,
      ...overrides,
    });
  }

  async function activityOf(issueId: string, action: string) {
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    return rows.filter((row) => row.action === action);
  }

  it("keeps the reviewer asleep while the finished head is red and re-arms the monitor", async () => {
    const { issueId } = await seed();
    headCi({ finalCheckConclusion: "failure" });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_review");
    expect(issue.monitorNextCheckAt?.getTime()).toBe(TICK_AT.getTime() + REVIEW_CI_WAIT_INTERVAL_MS);
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(issue.monitorLastTriggeredAt).toBeNull();
    const deferred = await activityOf(issueId, "issue.monitor_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.details).toMatchObject({
      reason: "review_head_red",
      ciState: "complete",
      headSha: HEAD,
      attemptCount: 1,
    });
    expect(await activityOf(issueId, "issue.monitor_triggered")).toHaveLength(0);
    // The final check carried the verdict: the failed-checks list was not read.
    expect(mockReviewCi.resolveHeadFailedChecks).not.toHaveBeenCalled();
  });

  it("reads the failed checks when the final check carries no verdict, and waits on a failed one", async () => {
    const { issueId } = await seed();
    headCi({ finalCheckConclusion: null });
    mockReviewCi.resolveHeadFailedChecks.mockResolvedValue({
      state: "ok",
      headSha: HEAD,
      pullRequestUrl: PR_URL,
      failed: ["main-green"],
    });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(mockReviewCi.resolveHeadFailedChecks).toHaveBeenCalledWith(
      expect.objectContaining({ issueId, headSha: HEAD }),
    );
    const deferred = await activityOf(issueId, "issue.monitor_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.details).toMatchObject({ reason: "review_head_red" });
  });

  it("keeps waiting while CI runs, exactly as before", async () => {
    const { issueId } = await seed();
    headCi({ state: "pending" });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    // First tick of the growing step: 30 seconds.
    expect(issue.monitorNextCheckAt?.getTime()).toBe(TICK_AT.getTime() + 30_000);
    const deferred = await activityOf(issueId, "issue.monitor_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.details).toMatchObject({ reason: "review_ci_pending", ciState: "pending" });
    expect(mockReviewCi.resolveHeadFailedChecks).not.toHaveBeenCalled();
  });
});
