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
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@myrmidon/shared";
import { REVIEW_CI_WAIT_MONITOR_SERVICE_NAME } from "../myrmidon/review-stage-recovery/policy.ts";
import { reviewWakesQuotaForCompany } from "../myrmidon/review-stage-recovery/review-wakes-quota.ts";
import {
  CI_NO_ACCESS_NOTE,
  decideUnchangedBackoff,
  isCiAccessDeniedReason,
  MONITOR_UNCHANGED_BACKOFF_MAX_MS,
} from "../myrmidon/issue-monitor-idle/policy.ts";
import { readIssueMonitorSnapshotHash } from "../myrmidon/issue-monitor-idle/store.ts";

// myrmidon(EMPTY-RUNS-MONITOR, 1.6.9): monitor wakes that cannot change anything.
//  - the attempt limit holds for a monitor kept in `execution_state` only (OPE-2749: 88 of 20);
//  - the board's own waits (reviewer-wake quota, a review without a reviewer) do not wake anyone;
//  - an unchanged fingerprint backs off, up to four hours;
//  - a repository whose CI cannot be read (no access) is dropped after three terms.

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

// The tick clears the reviewer-wake quota at its start; the test spends it beforehand.
vi.mock("../myrmidon/review-stage-recovery/review-wakes-quota.js", async () => {
  const actual = await vi.importActual<typeof import("../myrmidon/review-stage-recovery/review-wakes-quota.js")>(
    "../myrmidon/review-stage-recovery/review-wakes-quota.js",
  );
  return { ...actual, clearReviewWakesQuotas: () => undefined };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres empty-runs monitor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const PR_URL = "https://github.com/company-a/example.com/pull/7";
const DUE_AT = new Date("2026-04-11T12:30:00.000Z");
const TICK_AT = new Date("2026-04-11T12:31:00.000Z");

describe("pure decisions of the empty-runs monitor fix", () => {
  const previous = { snapshotHash: "h", unchangedCount: 0 };

  it("doubles the pause with each unchanged term and stops at four hours", () => {
    const now = new Date("2026-04-11T00:00:00.000Z");
    const pauses = [0, 1, 2, 3, 4, 5, 6, 30].map((count) => {
      const decision = decideUnchangedBackoff({
        now,
        snapshotHash: "h",
        previous: { ...previous, unchangedCount: count },
      });
      if (decision.action !== "defer") throw new Error("expected a deferral");
      return decision.nextCheckAt.getTime() - now.getTime();
    });
    expect(pauses).toEqual([10, 20, 40, 80, 160, 240, 240, 240].map((minutes) => minutes * 60_000));
    expect(Math.max(...pauses)).toBe(MONITOR_UNCHANGED_BACKOFF_MAX_MS);
  });

  it("wakes at once for a changed fingerprint or without an earlier record", () => {
    const now = new Date("2026-04-11T00:00:00.000Z");
    expect(decideUnchangedBackoff({ now, snapshotHash: "other", previous })).toEqual({ action: "wake" });
    expect(decideUnchangedBackoff({ now, snapshotHash: "h", previous: null })).toEqual({ action: "wake" });
  });

  it("tells a refused repository from a rate limit", () => {
    expect(isCiAccessDeniedReason("pull:http_404+anonymous:http_404")).toBe(true);
    expect(isCiAccessDeniedReason("pull:http_403 (anonymous)")).toBe(true);
    expect(isCiAccessDeniedReason("pull:http_403_rate_limited")).toBe(false);
    // The token was refused, the anonymous read was only rate limited: not a verdict on access.
    expect(isCiAccessDeniedReason("pull:http_403+anonymous:http_403_rate_limited")).toBe(false);
    expect(isCiAccessDeniedReason("check_runs:network_error")).toBe(false);
    expect(isCiAccessDeniedReason(null)).toBe(false);
  });
});

describeEmbeddedPostgres("issue monitors that cannot change anything", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-empty-runs-monitor-");
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
    throw new Error("Timed out waiting for empty-runs monitor heartbeat side effects to settle");
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

  function monitorState(overrides: Record<string, unknown>) {
    return {
      status: "scheduled",
      nextCheckAt: DUE_AT.toISOString(),
      lastTriggeredAt: null,
      attemptCount: 0,
      notes: "wait",
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: "Owner-provided historical evidence",
      externalRef: null,
      timeoutAt: null,
      maxAttempts: null,
      recoveryPolicy: "wake_owner",
      clearedAt: null,
      clearReason: null,
      ...overrides,
    };
  }

  function executionState(monitor: Record<string, unknown>, review?: { reviewerId: string; engineerId: string }) {
    return {
      status: review ? "pending" : "idle",
      currentStageId: review ? randomUUID() : null,
      currentStageIndex: review ? 0 : null,
      currentStageType: review ? "review" : null,
      currentParticipant: review ? { type: "agent", agentId: review.reviewerId } : null,
      returnAssignee: review ? { type: "agent", agentId: review.engineerId } : null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor,
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const engineerId = randomUUID();
    const reviewerId = randomUUID();
    const issuePrefix = `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
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
    return { companyId, engineerId, reviewerId, issuePrefix };
  }

  /** The re-arm of a monitor after its term: due again at `dueAt`, wake claim released. */
  async function rearm(issueId: string, dueAt: Date) {
    await db
      .update(issues)
      .set({ monitorNextCheckAt: dueAt, monitorWakeRequestedAt: null })
      .where(eq(issues.id, issueId));
  }

  async function activityOf(issueId: string, action: string) {
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    return rows.filter((row) => row.action === action);
  }

  async function seedReviewWait(input: { withReviewer: boolean; stateOnly?: boolean }) {
    const { companyId, engineerId, reviewerId, issuePrefix } = await seedCompany();
    const issueId = randomUUID();
    const notes = "Review admission waits for the next tick's reviewer-wake quota (1 per tick)";
    const monitor = {
      nextCheckAt: DUE_AT.toISOString(),
      notes,
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME,
      timeoutAt: null,
      maxAttempts: null,
      recoveryPolicy: "wake_owner",
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Land the change",
      status: input.withReviewer ? "in_review" : "in_progress",
      priority: "medium",
      assigneeAgentId: input.withReviewer ? reviewerId : engineerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      // stateOnly: the monitor survived a trigger only in execution_state (the policy has none).
      executionPolicy: input.stateOnly ? null : { mode: "normal", commentRequired: true, stages: [], monitor },
      executionState: executionState(
        monitorState({ notes, serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME }),
        input.withReviewer ? { reviewerId, engineerId } : undefined,
      ),
      monitorNextCheckAt: DUE_AT,
      monitorAttemptCount: 0,
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

  it("stops a monitor kept only in execution_state at its attempt limit: no wake, one note, status kept", async () => {
    const { companyId, engineerId, issuePrefix } = await seedCompany();
    const issueId = randomUUID();
    // OPE-2749: the policy has no monitor (a trigger strips it), the limit lives in the state.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Waiting for evidence",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: engineerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: null,
      executionState: executionState(monitorState({ attemptCount: 88, maxAttempts: 20 })),
      monitorNextCheckAt: DUE_AT,
      monitorAttemptCount: 88,
      monitorNotes: "wait",
      monitorScheduledBy: "assignee",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    let [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("blocked");
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(await activityOf(issueId, "issue.monitor_exhausted")).toHaveLength(1);
    let comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("исчерпан предел попыток (88 из 20, срок ");

    // Armed again by the owner's own path: still no wake and still one note.
    await db
      .update(issues)
      .set({
        executionState: executionState(monitorState({ attemptCount: 88, maxAttempts: 20 })),
        monitorNextCheckAt: DUE_AT,
      })
      .where(eq(issues.id, issueId));
    expect((await heartbeat.tickTimers(TICK_AT)).enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt).toBeNull();
  });

  it("stops a policy monitor at its attempt limit without waking the owner", async () => {
    const { companyId, engineerId, issuePrefix } = await seedCompany();
    const issueId = randomUUID();
    const monitor = {
      nextCheckAt: DUE_AT.toISOString(),
      notes: "wait",
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: "CI",
      timeoutAt: null,
      maxAttempts: 2,
      recoveryPolicy: "wake_owner",
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Waiting for CI",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: engineerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor },
      executionState: executionState(monitorState({ attemptCount: 2, maxAttempts: 2, serviceName: "CI" })),
      monitorNextCheckAt: DUE_AT,
      monitorAttemptCount: 2,
      monitorNotes: "wait",
      monitorScheduledBy: "assignee",
    });

    expect((await heartbeatService(db).tickTimers(TICK_AT)).enqueued).toBe(0);

    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_progress");
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(1);
  });

  it("does not wake the reviewer or the executor on the reviewer-wake quota: the monitor waits for a free slot", async () => {
    const { companyId, issueId } = await seedReviewWait({ withReviewer: true });
    mockReviewCi.resolveCi.mockResolvedValue({
      state: "complete",
      pullRequestUrl: PR_URL,
      headSha: HEAD,
      finalCheckConclusion: "success",
    });
    reviewWakesQuotaForCompany(companyId).remaining = 0;

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_review");
    expect(issue.monitorNextCheckAt?.getTime()).toBe(TICK_AT.getTime() + 60_000);
    // A quota deferral spends no attempt.
    expect(issue.monitorAttemptCount).toBe(0);
    const deferred = await activityOf(issueId, "issue.monitor_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.details).toMatchObject({ reason: "review_wake_quota" });
    expect(await activityOf(issueId, "issue.monitor_triggered")).toHaveLength(0);
  });

  it("does not wake the executor for a review wait that has no reviewer left: the monitor is removed", async () => {
    const { engineerId, issueId } = await seedReviewWait({ withReviewer: false });

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, engineerId))).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_progress");
    expect(issue.monitorNextCheckAt).toBeNull();
    const cleared = await activityOf(issueId, "issue.monitor_cleared");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.details).toMatchObject({ reason: "review_wait_without_reviewer" });
  });

  /** A task with a pull request whose monitor is due; `serviceName` and `kind` set what the monitor waits for. */
  async function seedLeafMonitor(input: { serviceName: string; kind: string; withPullRequest: boolean }) {
    const { companyId, engineerId, issuePrefix } = await seedCompany();
    const issueId = randomUUID();
    const monitor = {
      nextCheckAt: DUE_AT.toISOString(),
      notes: "wait",
      scheduledBy: "assignee",
      kind: input.kind,
      serviceName: input.serviceName,
      timeoutAt: null,
      maxAttempts: null,
      recoveryPolicy: "wake_owner",
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Waiting",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: engineerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor },
      executionState: executionState(monitorState({ serviceName: input.serviceName, kind: input.kind })),
      monitorNextCheckAt: DUE_AT,
      monitorAttemptCount: 0,
      monitorNotes: "wait",
      monitorScheduledBy: "assignee",
    });
    if (input.withPullRequest) {
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
    }
    const rearmed = (dueAt: Date) => ({
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: { ...monitor, nextCheckAt: dueAt.toISOString() } },
      executionState: executionState(
        monitorState({ serviceName: input.serviceName, kind: input.kind, nextCheckAt: dueAt.toISOString() }),
      ),
      monitorNextCheckAt: dueAt,
      monitorWakeRequestedAt: null,
    });
    const recordWake = async (extra?: Record<string, unknown>) => {
      const snapshotHash = await readIssueMonitorSnapshotHash(db, {
        companyId,
        issueId,
        ownerAgentId: engineerId,
        allowLeaf: true,
      });
      expect(snapshotHash).not.toBeNull();
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "heartbeat_scheduler",
        action: "issue.monitor_triggered",
        entityType: "issue",
        entityId: issueId,
        details: { snapshotHash, unchangedCount: 0 },
        ...extra,
      });
    };
    return { companyId, engineerId, issueId, rearmed, recordWake };
  }

  it("backs off an unchanged wait the board reads itself (CI of a pull request): 10 min, 20 min, and wakes when it changes", async () => {
    const { companyId, issueId, rearmed, recordWake } = await seedLeafMonitor({
      serviceName: "CI",
      kind: "external_service",
      withPullRequest: true,
    });
    await recordWake();
    const heartbeat = heartbeatService(db);

    expect((await heartbeat.tickTimers(TICK_AT)).enqueued).toBe(0);
    let [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt?.getTime()).toBe(TICK_AT.getTime() + 10 * 60_000);

    const second = new Date(TICK_AT.getTime() + 11 * 60_000);
    await db.update(issues).set(rearmed(new Date(second.getTime() - 1_000))).where(eq(issues.id, issueId));
    expect((await heartbeat.tickTimers(second)).enqueued).toBe(0);
    [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt?.getTime()).toBe(second.getTime() + 20 * 60_000);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

    // Something changed (a comment from someone else): the next term wakes the owner.
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "CI is green now",
    });
    const third = new Date(second.getTime() + 21 * 60_000);
    await db.update(issues).set(rearmed(new Date(third.getTime() - 1_000))).where(eq(issues.id, issueId));
    expect((await heartbeat.tickTimers(third)).enqueued).toBe(1);
    await waitForHeartbeatSideEffectsSettled();
  });

  it("wakes a monitor of an external service on its date even when the board sees nothing new", async () => {
    const { engineerId, recordWake } = await seedLeafMonitor({
      serviceName: "Deploy of the staging stand",
      kind: "external_service",
      withPullRequest: false,
    });
    await recordWake();

    expect((await heartbeatService(db).tickTimers(TICK_AT)).enqueued).toBe(1);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, engineerId));
    expect(wakeups.map((row) => row.reason)).toEqual(["issue_monitor_due"]);
    await waitForHeartbeatSideEffectsSettled();
  });

  it("ignores an observation of an earlier monitor instance (older than the last trigger)", async () => {
    const { issueId, recordWake } = await seedLeafMonitor({
      serviceName: "CI",
      kind: "external_service",
      withPullRequest: true,
    });
    // The same fingerprint was recorded in January; the monitor was last triggered in April.
    await recordWake({ createdAt: new Date("2026-01-05T10:00:00.000Z") });
    await db
      .update(issues)
      .set({ monitorLastTriggeredAt: new Date("2026-04-01T10:00:00.000Z") })
      .where(eq(issues.id, issueId));

    expect((await heartbeatService(db).tickTimers(TICK_AT)).enqueued).toBe(1);
    await waitForHeartbeatSideEffectsSettled();
  });

  it("applies the review-CI wait to a monitor kept only in execution_state: the reviewer quota defers, nobody is woken", async () => {
    const { companyId, issueId } = await seedReviewWait({ withReviewer: true, stateOnly: true });
    mockReviewCi.resolveCi.mockResolvedValue({
      state: "complete",
      pullRequestUrl: PR_URL,
      headSha: HEAD,
      finalCheckConclusion: "success",
    });
    reviewWakesQuotaForCompany(companyId).remaining = 0;

    expect((await heartbeatService(db).tickTimers(TICK_AT)).enqueued).toBe(0);

    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt?.getTime()).toBe(TICK_AT.getTime() + 60_000);
    const deferred = await activityOf(issueId, "issue.monitor_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.details).toMatchObject({ reason: "review_wake_quota" });
  });

  it("leaves a provider-quota monitor kept only in execution_state alone on an in-review task: nobody is woken", async () => {
    const { reviewerId, engineerId, issueId } = await seedReviewWait({ withReviewer: true, stateOnly: true });
    await db
      .update(issues)
      .set({
        executionState: executionState(
          monitorState({ serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: null }),
          { reviewerId, engineerId },
        ),
      })
      .where(eq(issues.id, issueId));

    const result = await heartbeatService(db).tickTimers(TICK_AT);

    expect(result.enqueued).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt?.getTime()).toBe(DUE_AT.getTime());
    expect(await activityOf(issueId, "issue.monitor_triggered")).toHaveLength(0);
  });

  it("reads CI access for a review wait kept only in execution_state", async () => {
    const { issueId } = await seedReviewWait({ withReviewer: true, stateOnly: true });
    mockReviewCi.resolveCi.mockResolvedValue({
      state: "unknown",
      pullRequestUrl: PR_URL,
      headSha: null,
      reason: "pull:http_404+anonymous:http_404",
    });

    expect((await heartbeatService(db).tickTimers(TICK_AT)).enqueued).toBe(0);

    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const deferred = await activityOf(issueId, "issue.monitor_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.details).toMatchObject({ reason: "review_ci_no_access" });
  });

  it("gives each exhausted monitor its own note (the due time is part of it)", async () => {
    const { companyId, engineerId, issuePrefix } = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Waiting for evidence",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: engineerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: null,
      executionState: executionState(monitorState({ attemptCount: 5, maxAttempts: 5 })),
      monitorNextCheckAt: DUE_AT,
      monitorAttemptCount: 5,
      monitorNotes: "wait",
      monitorScheduledBy: "assignee",
    });
    const heartbeat = heartbeatService(db);
    await heartbeat.tickTimers(TICK_AT);

    const later = new Date(DUE_AT.getTime() + 3 * 60 * 60_000);
    await db
      .update(issues)
      .set({
        executionState: executionState(monitorState({ attemptCount: 5, maxAttempts: 5, nextCheckAt: later.toISOString() })),
        monitorNextCheckAt: later,
        monitorWakeRequestedAt: null,
      })
      .where(eq(issues.id, issueId));
    await heartbeat.tickTimers(new Date(later.getTime() + 60_000));

    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(notes).toHaveLength(2);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("drops a monitor whose CI cannot be read for lack of access: three terms in a row AND 15 minutes, with one note", async () => {
    const { issueId } = await seedReviewWait({ withReviewer: true });
    mockReviewCi.resolveCi.mockResolvedValue({
      state: "unknown",
      pullRequestUrl: PR_URL,
      headSha: null,
      reason: "pull:http_404+anonymous:http_404",
    });
    const heartbeat = heartbeatService(db);
    const termAt = (minutes: number) => new Date(TICK_AT.getTime() + minutes * 60_000);

    // Terms at 0, 5 and 10 minutes: three in a row, but the window is not 15 minutes yet.
    for (const minutes of [0, 5, 10]) {
      if (minutes > 0) await rearm(issueId, new Date(termAt(minutes).getTime() - 1_000));
      expect((await heartbeat.tickTimers(termAt(minutes))).enqueued).toBe(0);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue.monitorNextCheckAt).not.toBeNull();
    }
    expect(await activityOf(issueId, "issue.monitor_deferred")).toHaveLength(3);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);

    await rearm(issueId, new Date(termAt(15).getTime() - 1_000));
    expect((await heartbeat.tickTimers(termAt(15))).enqueued).toBe(0);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.status).toBe("in_review");
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.map((row) => row.body)).toEqual([CI_NO_ACCESS_NOTE]);
    const cleared = await activityOf(issueId, "issue.monitor_cleared");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.details).toMatchObject({ reason: "review_ci_no_access" });
  });
});
