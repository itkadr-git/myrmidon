// myrmidon(OPE-10045): a reviewer run that ended without a decision while the
// execution-review stage is pending. Waiting for CI on the PR head is not a
// stall, the reviewer gets an explicit decision request before the board
// escalation, and the escalation keeps the stage.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { logger } from "../../middleware/logger.js";
import {
  REVIEW_CI_WAIT_MAX_ATTEMPTS,
  REVIEW_CI_WAIT_MONITOR_SERVICE_NAME,
  REVIEW_STAGE_RECOVERY_DEFERRED_ACTION,
  type ReviewPullRequestCiFacts,
} from "../../myrmidon/review-stage-recovery/policy.js";
import { recoveryService } from "./service.js";
import { buildExecutionReviewParticipantRecoveryNoticeSeed } from "./stranded-notice.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PR_URL = "https://github.com/acme/app/pull/7";

describeEmbeddedPostgres("escalateStrandedAssignedIssue: stalled execution review (OPE-10045)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalAutoPolicyEnabled = process.env.MYRMIDON_STRANDED_AUTOPOLICY_ENABLED;

  beforeAll(async () => {
    process.env.MYRMIDON_STRANDED_AUTOPOLICY_ENABLED = "false";
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-review-stage-recovery-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (originalAutoPolicyEnabled === undefined) delete process.env.MYRMIDON_STRANDED_AUTOPOLICY_ENABLED;
    else process.env.MYRMIDON_STRANDED_AUTOPOLICY_ENABLED = originalAutoPolicyEnabled;
  });

  async function seed(input: { reviewerStatus?: string } = {}) {
    const companyId = randomUUID();
    const engineerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const stageId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Myrmidon",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: engineerAgentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: input.reviewerStatus ?? "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "execution_review_participant_recovery",
        retryReason: "execution_review_participant_recovery",
        source: "issue.execution_review_recovery",
      },
      startedAt: new Date(now.getTime() - 60_000),
      finishedAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review waits for CI",
      status: "in_review",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
      assigneeUserId: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: engineerAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    return { companyId, engineerAgentId, reviewerAgentId, issueId, runId, stageId };
  }

  function createService(ci: ReviewPullRequestCiFacts) {
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> | undefined }> = [];
    const service = recoveryService(db, {
      enqueueWakeup: async (agentId, opts) => {
        wakes.push({ agentId, opts: opts as Record<string, unknown> | undefined });
        return { id: randomUUID(), status: "queued" } as unknown as typeof heartbeatRuns.$inferSelect;
      },
      resolveReviewPullRequestCi: async () => ci,
    });
    return { service, wakes };
  }

  async function escalate(service: ReturnType<typeof recoveryService>, seeded: Awaited<ReturnType<typeof seed>>) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    return service.escalateStrandedAssignedIssue({
      issue: issue!,
      previousStatus: "in_review",
      latestRun: run!,
      notice: buildExecutionReviewParticipantRecoveryNoticeSeed(),
      recoveryCause: "execution_review_participant_recovery",
    });
  }

  async function readIssue(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return issue!;
  }

  async function deferrals(issueId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, REVIEW_STAGE_RECOVERY_DEFERRED_ACTION)));
  }

  it("waits for CI on the PR head instead of blocking the task", async () => {
    const seeded = await seed();
    const { service, wakes } = createService({ state: "pending", pullRequestUrl: PR_URL, headSha: "abc123" });

    const result = await escalate(service, seeded);

    expect(result).toBeTruthy();
    expect(wakes).toHaveLength(0);
    const issue = await readIssue(seeded.issueId);
    expect(issue.status).toBe("in_review");
    expect(issue.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    expect(issue.executionPolicy).toMatchObject({
      monitor: { serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME, kind: "external_service", externalRef: PR_URL },
    });
    expect(issue.executionState).toMatchObject({
      status: "pending",
      currentStageId: seeded.stageId,
      currentParticipant: { type: "agent", agentId: seeded.reviewerAgentId },
      returnAssignee: { type: "agent", agentId: seeded.engineerAgentId },
    });
    const rows = await deferrals(seeded.issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({
      kind: "ci_wait",
      stageId: seeded.stageId,
      ciState: "pending",
      pullRequestUrl: PR_URL,
      headSha: "abc123",
    });
  });

  it("waits for CI instead of blocking when the CI state cannot be read, and logs why once (OPE-10063)", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    try {
      const seeded = await seed();
      const { service, wakes } = createService({
        state: "unknown",
        pullRequestUrl: PR_URL,
        headSha: null,
        reason: "pull:http_404 (anonymous)",
      });

      const result = await escalate(service, seeded);

      expect(result).toBeTruthy();
      expect(wakes).toHaveLength(0);
      const issue = await readIssue(seeded.issueId);
      expect(issue.status).toBe("in_review");
      expect(issue.monitorNextCheckAt).toBeInstanceOf(Date);
      expect(issue.executionPolicy).toMatchObject({
        monitor: { serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME, kind: "external_service", externalRef: PR_URL },
      });
      expect(issue.executionState).toMatchObject({
        status: "pending",
        currentStageId: seeded.stageId,
        currentParticipant: { type: "agent", agentId: seeded.reviewerAgentId },
      });
      const rows = await deferrals(seeded.issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({
        kind: "ci_wait",
        attempt: 1,
        maxAttempts: REVIEW_CI_WAIT_MAX_ATTEMPTS,
        ciState: "unknown",
        ciUnknownReason: "pull:http_404 (anonymous)",
      });
      const warnings = warn.mock.calls.filter((call) => String(call[1] ?? "").includes("OPE-10063"));
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]![1])).toContain("pull:http_404 (anonymous)");
    } finally {
      warn.mockRestore();
    }
  });

  it("escalates when the CI state stays unreadable past the wait limit", async () => {
    const seeded = await seed();
    await db.insert(activityLog).values([
      ...Array.from({ length: REVIEW_CI_WAIT_MAX_ATTEMPTS }, (_, index) => ({
        companyId: seeded.companyId,
        actorType: "system" as const,
        actorId: "recovery",
        action: REVIEW_STAGE_RECOVERY_DEFERRED_ACTION,
        entityType: "issue",
        entityId: seeded.issueId,
        details: { kind: "ci_wait", stageId: seeded.stageId, attempt: index + 1 },
      })),
      {
        companyId: seeded.companyId,
        actorType: "system" as const,
        actorId: "recovery",
        action: REVIEW_STAGE_RECOVERY_DEFERRED_ACTION,
        entityType: "issue",
        entityId: seeded.issueId,
        details: { kind: "decision_retry", stageId: seeded.stageId, attempt: 2 },
      },
    ]);
    const { service, wakes } = createService({
      state: "unknown",
      pullRequestUrl: PR_URL,
      headSha: null,
      reason: "pull:http_404 (anonymous)",
    });

    await escalate(service, seeded);

    expect(wakes).toHaveLength(0);
    expect((await readIssue(seeded.issueId)).status).toBe("blocked");
  });

  it("schedules the next check after GitHub's rate limit reset (OPE-10246)", async () => {
    const seeded = await seed();
    // The reset is far in the future: the wait must not wake before it.
    const resetEpochSeconds = Math.ceil((Date.now() + 3 * 60 * 60 * 1000) / 1000);
    const { service, wakes } = createService({
      state: "unknown",
      pullRequestUrl: PR_URL,
      headSha: "abc123",
      reason: "pull:http_403_rate_limited",
      rateLimit: { remaining: 0, limit: 15000, resetEpochSeconds },
    });

    const result = await escalate(service, seeded);

    expect(result).toBeTruthy();
    expect(wakes).toHaveLength(0);
    const issue = await readIssue(seeded.issueId);
    expect(issue.status).toBe("in_review");
    expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThanOrEqual(resetEpochSeconds * 1000);
    const rows = await deferrals(seeded.issueId);
    expect(rows[0]!.details).toMatchObject({
      kind: "ci_wait",
      ciState: "unknown",
      ciUnknownReason: "pull:http_403_rate_limited",
      rateLimitRemaining: 0,
      rateLimitResetEpoch: resetEpochSeconds,
    });
    const notes = String((issue.executionPolicy as { monitor?: { notes?: string } }).monitor?.notes ?? "");
    expect(notes).toContain(`rate limit reset at ${new Date(resetEpochSeconds * 1000).toISOString()}`);
  });

  it("wakes the reviewer once more with the explicit decision request when CI is finished", async () => {
    const seeded = await seed();
    const { service, wakes } = createService({ state: "complete", pullRequestUrl: PR_URL, headSha: "abc123" });

    const result = await escalate(service, seeded);

    expect(result).toBeTruthy();
    expect((await readIssue(seeded.issueId)).status).toBe("in_review");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(seeded.reviewerAgentId);
    expect(wakes[0]!.opts).toMatchObject({
      reason: "execution_review_participant_recovery",
      contextSnapshot: {
        issueId: seeded.issueId,
        retryReason: "execution_review_participant_recovery",
        source: "issue.execution_review_recovery",
        currentStageId: seeded.stageId,
        reviewDecisionRetryAttempt: 2,
        reviewRecoveryInstruction: expect.stringContaining("status=done"),
      },
    });
    const rows = await deferrals(seeded.issueId);
    expect(rows.map((row) => (row.details as Record<string, unknown>).kind)).toEqual(["decision_retry"]);
  });

  it("escalates after the decision retries and keeps the review stage", async () => {
    const seeded = await seed();
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "recovery",
      action: REVIEW_STAGE_RECOVERY_DEFERRED_ACTION,
      entityType: "issue",
      entityId: seeded.issueId,
      details: { kind: "decision_retry", stageId: seeded.stageId, attempt: 2 },
    });
    const { service, wakes } = createService({ state: "complete", pullRequestUrl: PR_URL, headSha: "abc123" });

    await escalate(service, seeded);

    expect(wakes).toHaveLength(0);
    const issue = await readIssue(seeded.issueId);
    expect(issue.status).toBe("blocked");
    expect(issue.executionState).toMatchObject({
      status: "pending",
      currentStageId: seeded.stageId,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: seeded.reviewerAgentId },
      returnAssignee: { type: "agent", agentId: seeded.engineerAgentId },
    });
    const escalation = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, seeded.issueId), eq(activityLog.action, "issue.updated")));
    expect(escalation.map((row) => (row.details as Record<string, unknown>).source)).toContain(
      "recovery.reconcile_execution_review_participant",
    );
  });

  it("still escalates at once when the reviewer cannot be invoked", async () => {
    const seeded = await seed({ reviewerStatus: "paused" });
    const { service, wakes } = createService({ state: "pending", pullRequestUrl: PR_URL, headSha: "abc123" });

    await escalate(service, seeded);

    expect(wakes).toHaveLength(0);
    expect(await deferrals(seeded.issueId)).toHaveLength(0);
    expect((await readIssue(seeded.issueId)).status).toBe("blocked");
  });
});
