import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentRuntimeState,
  companySkills,
  heartbeatRunEvents,
  heartbeatRuns,
  agentWakeupRequests,
  agentTaskSessions,
  issueComments,
  issueWorkProducts,
  issues,
} from "@myrmidon/db";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { REVIEW_CI_WAIT_MONITOR_SERVICE_NAME, reviewAdmissionDedupKey } from "../myrmidon/review-stage-recovery/policy.js";
import { readReviewRoutingSignals, resetReviewRoutingSignals } from "../myrmidon/review-routing/attention.js";

/**
 * myrmidon(OPE-12177): seeds the issue's open pull_request work product whose
 * metadata carries the head SHA the real `readReviewPullRequestHeadSha` reads.
 * `readReviewPullRequestHeadSha` may only be stubbed in tests that assert the
 * fallback when nothing is readable.
 */
async function insertPullRequestWorkProduct(input: {
  db: typeof ctx.db;
  companyId: string;
  issueId: string;
  headSha: string;
}) {
  await input.db.insert(issueWorkProducts).values({
    companyId: input.companyId,
    issueId: input.issueId,
    type: "pull_request",
    provider: "github",
    title: "Review admission PR",
    url: `https://github.com/acme/app/pull/7`,
    status: "open",
    isPrimary: true,
    metadata: { repo: "acme/app", number: 7, headSha: input.headSha },
  });
}

// myrmidon(REVIEW-ADMISSION): issue transition to in_review and reviewer wake
// must be written in the same database transaction via PATCH /api/issues/:id.

const ctx = useEmbeddedPostgres("myrmidon-review-admission-", {
  resetEach: async (db) => {
    // Await background wake/run handlers before taking table locks: a handler
    // may need those relations while it finishes its transaction.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.transaction(async (tx) => {
      // Prevent new wake/activity writers while deleting their rows and issues.
      await tx.execute(
        sql`LOCK TABLE activity_log, agent_runtime_state, agent_task_sessions, agent_wakeup_requests, issue_comments, issues, agents, company_skills IN SHARE ROW EXCLUSIVE MODE`,
      );
      await tx.delete(heartbeatRunEvents);
      await tx.update(agentTaskSessions).set({ lastRunId: null });
      await tx.delete(activityLog);
      await tx.delete(heartbeatRuns);
      await tx.delete(agentWakeupRequests);
      await tx.delete(issueComments);
      await tx.delete(issues);
      await tx.delete(agentRuntimeState);
      await tx.delete(agentTaskSessions);
      await tx.delete(agents);
      await tx.delete(companySkills);
      await resetCompanyIssueFixtures(tx as typeof db);
    });
  },
});

describeEmbeddedPostgres("myrmidon review admission atomic wake persistence", () => {
  it("raises one no_reviewer signal on real PATCH when no eligible reviewer exists", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission no reviewer");
    resetReviewRoutingSignals();
    const authorAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: authorAgentId,
      companyId,
      name: "Task Author",
      metadata: { telegramGroup: "dev" },
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No reviewer route regression",
      status: "todo",
      priority: "medium",
      createdByAgentId: authorAgentId,
    });

    const first = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });
    expect(first.status).toBe(200);
    expect(readReviewRoutingSignals(companyId).filter((signal) => signal.issueId === issueId)).toHaveLength(1);

    const repeated = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });
    expect(repeated.status).toBe(200);
    expect(readReviewRoutingSignals(companyId).filter((signal) => signal.issueId === issueId)).toHaveLength(1);

    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Eligible Reviewer",
      metadata: { telegramGroup: "dev" },
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const policy = {
      mode: "normal",
      stages: [
        {
          id: randomUUID(),
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId, userId: null }],
        },
      ],
    };
    const assigned = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: policy });
    expect(assigned.status).toBe(200);
    expect(readReviewRoutingSignals(companyId).filter((signal) => signal.issueId === issueId)).toHaveLength(0);
  });

  it("defers reviewer admission while exact PR-head CI is pending", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission waits for exact-head CI");
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "CI-gated Reviewer",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    const stageId = randomUUID();
    const policy = {
      mode: "normal",
      stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId, userId: null }] }],
    };
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pending CI must not wake reviewer",
      status: "todo",
      priority: "medium",
      executionPolicy: policy,
    });
    const pendingCiRoutes = (db: any, storage: any) => issueRoutes(db, storage, {
      resolveReviewPullRequestCi: async () => ({ state: "pending", pullRequestUrl: "https://github.com/acme/app/pull/7", headSha: "head-abc" }),
    });

    const response = await request(routeApp(ctx.db, actor, pendingCiRoutes as any))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", executionPolicy: policy });

    expect(response.status).toBe(200);
    const wakes = await ctx.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, reviewAdmissionDedupKey({ issueId, headSha: "head-abc", agentId: reviewerAgentId })));
    expect(wakes).toHaveLength(0);
    const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.executionPolicy).toMatchObject({ monitor: { serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME } });
    expect(issue?.monitorNextCheckAt).toBeInstanceOf(Date);
  });

  it("does not wake the review participant during recovery while CI is pending", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review participant recovery waits for CI");
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Recovery CI Reviewer",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    const stageId = randomUUID();
    const policy = {
      mode: "normal",
      stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId, userId: null }] }],
    };
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Participant recovery must wait for CI",
      status: "in_review",
      priority: "medium",
      executionPolicy: policy,
      executionState: { status: "pending", currentStageId: stageId, stages: policy.stages },
    });
    const pendingCiRoutes = (db: any, storage: any) => issueRoutes(db, storage, {
      resolveReviewPullRequestCi: async () => ({ state: "pending", pullRequestUrl: "https://github.com/acme/app/pull/7", headSha: "head-abc" }),
    });

    const response = await request(routeApp(ctx.db, actor, pendingCiRoutes as any))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", executionPolicy: policy, executionState: { status: "pending", currentStageId: stageId, stages: policy.stages } });

    expect(response.status).toBe(200);
    const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_review");
    const wakes = await ctx.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, reviewAdmissionDedupKey({ issueId, headSha: "head-abc", agentId: reviewerAgentId })));
    expect(wakes).toHaveLength(0);
  });

  it("records one operator activity when exact-head CI is unreadable", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission unreadable CI");
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "CI-unavailable Reviewer",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    const stageId = randomUUID();
    const policy = {
      mode: "normal",
      stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId, userId: null }] }],
    };
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unreadable CI should be logged once",
      status: "todo",
      priority: "medium",
      executionPolicy: policy,
    });
    const unreadableCiRoutes = (db: any, storage: any) => issueRoutes(db, storage, {
      resolveReviewPullRequestCi: async () => ({ state: "unknown", pullRequestUrl: "https://github.com/acme/app/pull/7", headSha: "head-abc", reason: "pull:http_403" }),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(routeApp(ctx.db, actor, unreadableCiRoutes as any))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_review", executionPolicy: policy });
      expect(response.status).toBe(200);
    }
    const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.executionState).toMatchObject({ currentStageId: stageId });
    const events = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(events.filter((event) => event.action === "review_ci_unreadable")).toHaveLength(1);
    const wakes = await ctx.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, reviewAdmissionDedupKey({ issueId, headSha: "head-abc", agentId: reviewerAgentId })));
    expect(wakes).toHaveLength(0);
  });

  it("transitions to in_review and writes reviewer wake atomically via real PATCH route", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission atomic");
    resetReviewRoutingSignals();
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Reviewer Agent",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const stageId = randomUUID();
    const policy = {
      stages: [
        {
          id: stageId,
          type: "review" as const,
          participants: [{ type: "agent" as const, agentId: reviewerAgentId }],
        },
      ],
    };

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Atomic review admission positive path",
      status: "todo",
      priority: "medium",
      executionPolicy: policy,
    });
    // myrmidon(OPE-12177): the dedup key tail is the stored PR head; the CI
    // resolver stub below confirms the same head.
    await insertPullRequestWorkProduct({ db: ctx.db, companyId, issueId, headSha: "head-abc" });

    const routesWithSuccessCi = (db: any, storage: any) => issueRoutes(db, storage, {
      resolveReviewPullRequestCi: async () => ({ state: "complete", pullRequestUrl: "https://github.com/acme/app/pull/7", headSha: "head-abc" }),
      resolveReviewHeadFailedChecks: async () => ({ state: "unknown", reason: "not_under_test" }),
    });
    const res = await request(routeApp(ctx.db, actor, routesWithSuccessCi as any))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        executionPolicy: policy,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(res.body.executionState?.currentParticipant).toMatchObject({
      type: "agent",
      agentId: reviewerAgentId,
    });

    const [issueRow] = await ctx.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueRow?.status).toBe("in_review");

    const wakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          reviewAdmissionDedupKey({ issueId, headSha: "head-abc", agentId: reviewerAgentId }),
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.companyId).toBe(companyId);
    expect(wakes[0]?.agentId).toBe(reviewerAgentId);
    expect(wakes[0]?.reason).toBe("execution_review_requested");
    expect(wakes[0]?.status).toBe("queued");
    expect(wakes[0]?.payload).toMatchObject({ issueId });
  });

  it("defers reviewer admission while exact PR-head CI completed with a failed check (OPE-12176)", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission terminal failure");
    const authorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values([
      {
        id: authorAgentId,
        companyId,
        name: "Issue Author",
        metadata: { telegramGroup: "dev" },
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
        name: "Reviewer Agent",
        metadata: { telegramGroup: "dev" },
        role: "reviewer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const stageId = randomUUID();
    const policy = {
      stages: [
        {
          id: stageId,
          type: "review" as const,
          participants: [{ type: "agent" as const, agentId: reviewerAgentId }],
        },
      ],
    };

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review admission terminal failure",
      status: "todo",
      priority: "medium",
      createdByAgentId: authorAgentId,
      executionPolicy: policy,
    });
    // myrmidon(OPE-12177): the head the admission gate reads from the stored
    // work product must match the CI stub's head below.
    await insertPullRequestWorkProduct({ db: ctx.db, companyId, issueId, headSha: "head-fail" });

    const routesWithFailureCi = (db: any, storage: any) => issueRoutes(db, storage, {
      resolveReviewPullRequestCi: async () => ({ state: "complete", pullRequestUrl: "https://github.com/acme/app/pull/7", headSha: "head-fail", finalCheckConclusion: "failure" }),
      resolveReviewHeadFailedChecks: async () => ({ state: "ok", headSha: "head-fail", pullRequestUrl: "https://github.com/acme/app/pull/7", failed: ["CI result"] }),
    });
    const res = await request(routeApp(ctx.db, actor, routesWithFailureCi as any))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        executionPolicy: policy,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    // myrmidon(OPE-12176): a red head must not reach the reviewer: no wake, a
    // CI-wait monitor with the failed-check reason instead. The stage keeps its
    // pending participant: the CI-wait monitor dispatches its recovery wake
    // through `executionState.currentParticipant` (heartbeat.ts), so removing
    // it here would leave the wait with no one to wake. The wake suppression is
    // asserted by the zero rows below.
    expect(res.body.executionState?.currentParticipant).toMatchObject({
      type: "agent",
      agentId: reviewerAgentId,
    });
    const wakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          reviewAdmissionDedupKey({ issueId, headSha: "head-fail", agentId: reviewerAgentId }),
        ),
      );
    expect(wakes).toHaveLength(0);
    const [deferredIssue] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(deferredIssue?.executionPolicy).toMatchObject({
      monitor: { serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME },
    });
    expect((deferredIssue?.executionPolicy as { monitor?: { notes?: string } } | null)?.monitor?.notes).toContain("CI result");
  });

  it("admits a critical issue's reviewer even when the exact PR-head CI completed with a failed check (OPE-12176)", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission critical bypass");
    const authorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values([
      {
        id: authorAgentId,
        companyId,
        name: "Issue Author",
        metadata: { telegramGroup: "dev" },
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
        name: "Reviewer Agent",
        metadata: { telegramGroup: "dev" },
        role: "reviewer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const stageId = randomUUID();
    const policy = {
      stages: [
        {
          id: stageId,
          type: "review" as const,
          participants: [{ type: "agent" as const, agentId: reviewerAgentId }],
        },
      ],
    };

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review admission critical bypass",
      status: "todo",
      priority: "critical",
      createdByAgentId: authorAgentId,
      executionPolicy: policy,
    });
    // myrmidon(OPE-12177): the head the admission gate reads from the stored
    // work product must match the CI stub's head below.
    await insertPullRequestWorkProduct({ db: ctx.db, companyId, issueId, headSha: "head-fail" });

    const routesWithFailureCi = (db: any, storage: any) => issueRoutes(db, storage, {
      resolveReviewPullRequestCi: async () => ({ state: "complete", pullRequestUrl: "https://github.com/acme/app/pull/7", headSha: "head-fail", finalCheckConclusion: "failure" }),
      resolveReviewHeadFailedChecks: async () => ({ state: "ok", headSha: "head-fail", pullRequestUrl: "https://github.com/acme/app/pull/7", failed: ["CI result"] }),
    });
    const res = await request(routeApp(ctx.db, actor, routesWithFailureCi as any))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        executionPolicy: policy,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(res.body.executionState?.currentParticipant).toMatchObject({
      type: "agent",
      agentId: reviewerAgentId,
    });

    const wakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          reviewAdmissionDedupKey({ issueId, headSha: "head-fail", agentId: reviewerAgentId }),
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.reason).toBe("execution_review_requested");
  });

  it("deduplicates reviewer wake on repeated transition or webhook replay", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission deduplication");
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Reviewer Agent",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const stageId = randomUUID();
    const policy = {
      stages: [
        {
          id: stageId,
          type: "review" as const,
          participants: [{ type: "agent" as const, agentId: reviewerAgentId }],
        },
      ],
    };

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review admission deduplication",
      status: "todo",
      priority: "medium",
      executionPolicy: policy,
    });
    // myrmidon(OPE-12177): both PATCHes below dedup on the stored PR head;
    // the CI stub confirms the same head so the admission gate admits.
    await insertPullRequestWorkProduct({ db: ctx.db, companyId, issueId, headSha: "head-abc" });

    const routesWithSuccessCi = (db: any, storage: any) => issueRoutes(db, storage, {
      resolveReviewPullRequestCi: async () => ({ state: "complete", pullRequestUrl: "https://github.com/acme/app/pull/7", headSha: "head-abc" }),
      resolveReviewHeadFailedChecks: async () => ({ state: "unknown", reason: "not_under_test" }),
    });
    const app = routeApp(ctx.db, actor, routesWithSuccessCi as any);

    const firstRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        executionPolicy: policy,
      });
    expect(firstRes.status).toBe(200);

    // Repeated transition / replay with same status and policy
    const secondRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        executionPolicy: policy,
      });
    expect(secondRes.status).toBe(200);

    const wakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          reviewAdmissionDedupKey({ issueId, headSha: "head-abc", agentId: reviewerAgentId }),
        ),
      );
    expect(wakes).toHaveLength(1);
  });

  it("myrmidon(OPE-12177): re-wakes with the same head dedup, a moved head wakes again, no SHA falls back", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission head-keyed dedup");
    const authorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values([
      {
        id: authorAgentId,
        companyId,
        name: "Issue Author",
        metadata: { telegramGroup: "dev" },
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
        name: "Head-keyed Reviewer",
        metadata: { telegramGroup: "dev" },
        role: "reviewer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const stageId = randomUUID();
    const policy = {
      stages: [
        {
          id: stageId,
          type: "review" as const,
          participants: [{ type: "agent" as const, agentId: reviewerAgentId }],
        },
      ],
    };

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Head-keyed review admission dedup",
      status: "todo",
      priority: "medium",
      assigneeAgentId: authorAgentId,
      createdByAgentId: authorAgentId,
      executionPolicy: policy,
    });
    // The dedup key tail is the exact PR head kept in the work-product
    // metadata; the real `readReviewPullRequestHeadSha` reads it. The CI
    // resolver stub only serves the admission gate and confirms the head.
    let storedHead = "head-abc";
    await insertPullRequestWorkProduct({ db: ctx.db, companyId, issueId, headSha: storedHead });
    // 1.6.7 (OPE-12177): the route rejects REQUEST CHANGES when CI is not complete or
    // unavailable. With headSha = null (no SHA), the stub returns not_configured so the
    // review admission verdict is allowed through.
    const routes = (db: any, storage: any) => issueRoutes(db, storage, {
      resolveReviewPullRequestCi: async () => ({
        state: (storedHead ? "complete" : "not_configured") as const,
        pullRequestUrl: "https://github.com/acme/app/pull/7",
        headSha: storedHead,
      }),
      resolveReviewHeadFailedChecks: async () => ({ state: "unknown" as const, reason: "not_under_test" }),
    });
    const app = routeApp(ctx.db, actor, routes as any);
    const sameHeadKey = reviewAdmissionDedupKey({ issueId, headSha: "head-abc", agentId: reviewerAgentId });
    const movedHeadKey = reviewAdmissionDedupKey({ issueId, headSha: "head-def", agentId: reviewerAgentId });
    const legacyKey = reviewAdmissionDedupKey({ issueId, headSha: null, agentId: reviewerAgentId });

    const firstRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", executionPolicy: policy });
    expect(firstRes.status).toBe(200);
    const firstWakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, sameHeadKey));
    expect(firstWakes).toHaveLength(1);
    expect(firstWakes[0]?.agentId).toBe(reviewerAgentId);

    // Same issue + same head: the wake is idempotent — no second admission row.
    const replayRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", executionPolicy: policy });
    expect(replayRes.status).toBe(200);
    expect(
      await ctx.db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, sameHeadKey)),
    ).toHaveLength(1);

    // The head moved (a pushed fix): the reviewer returns the task to the
    // executor (a board decision clears the pending stage), the metadata is
    // refreshed to the new head, and the next submission to review builds a
    // fresh key from that new head and wakes again.
    const returnRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "REQUEST CHANGES: fix the failing check" });
    expect(returnRes.status).toBe(200);
    storedHead = "head-def";
    await ctx.db
      .update(issueWorkProducts)
      .set({ metadata: { repo: "acme/app", number: 7, headSha: "head-def" }, updatedAt: new Date() })
      .where(eq(issueWorkProducts.issueId, issueId));
    const movedRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", executionPolicy: policy });
    expect(movedRes.status).toBe(200);
    const movedWakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, movedHeadKey));
    expect(movedWakes).toHaveLength(1);
    expect(movedWakes[0]?.agentId).toBe(reviewerAgentId);

    // No SHA readable at all: the legacy agent-keyed key is used so such
    // boards keep deduplicating exactly as before.
    storedHead = null as any;
    await ctx.db
      .update(issueWorkProducts)
      .set({ metadata: { repo: "acme/app", number: 7 }, updatedAt: new Date() })
      .where(eq(issueWorkProducts.issueId, issueId));
    const fallbackRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "REQUEST CHANGES: still broken" });
    expect(fallbackRes.status).toBe(200);
    const fallbackResubmit = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", executionPolicy: policy });
    expect(fallbackResubmit.status).toBe(200);
    if (process.env.OPE12177_DEBUG) {
      const allIssueWakes = await ctx.db
        .select({
          idempotencyKey: agentWakeupRequests.idempotencyKey,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
          source: agentWakeupRequests.source,
          runId: agentWakeupRequests.runId,
        })
        .from(agentWakeupRequests)
        .where(sql`${agentWakeupRequests.idempotencyKey} like ${`%${issueId}%`}`);
      console.error("DEBUG OPE-12177 fallback rows:", JSON.stringify(allIssueWakes, null, 1));
    }
    const fallbackWakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.idempotencyKey, legacyKey),
          // Reviewer-admission rows only. Recovery/continuation wakes of the
          // author-executor reuse the legacy fallback key tail but have a
          // different agent id; disposition outcomes of the reviewer's own
          // admission (liveness `failed`/`skipped`, OPE-12335 heartbeat
          // `coalesced`) carry the same key but are not a second admission.
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          notInArray(agentWakeupRequests.status, ["failed", "skipped", "coalesced"]),
        ),
      );
    expect(fallbackWakes).toHaveLength(1);
    expect(fallbackWakes[0]?.agentId).toBe(reviewerAgentId);
  });

  it("routes a review PATCH to a reviewer whose model differs from the author", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission routing");
    const authorAgentId = randomUUID();
    const sameModelReviewerId = randomUUID();
    const selectedReviewerId = randomUUID();
    await ctx.db.insert(agents).values([
      {
        id: authorAgentId,
        companyId,
        name: "Issue Author",
        metadata: { telegramGroup: "dev" },
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "model-a" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: sameModelReviewerId,
        companyId,
        name: "Same Model Reviewer",
        metadata: { telegramGroup: "dev" },
        role: "reviewer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "model-a" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: selectedReviewerId,
        companyId,
        name: "Different Model Reviewer",
        metadata: { telegramGroup: "dev" },
        role: "reviewer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "model-b" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Automatic reviewer selection",
      status: "todo",
      priority: "medium",
      createdByAgentId: authorAgentId,
    });

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(res.body.executionState?.currentParticipant).toMatchObject({
      type: "agent",
      agentId: selectedReviewerId,
    });
    expect(res.body.assigneeAgentId).toBe(selectedReviewerId);

    const wakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, reviewAdmissionDedupKey({ issueId, headSha: null, agentId: selectedReviewerId })));
    expect(wakes).toHaveLength(1);
    const rejectedCandidateWakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, reviewAdmissionDedupKey({ issueId, headSha: null, agentId: sameModelReviewerId })));
    expect(rejectedCandidateWakes).toHaveLength(0);
  });

  it("raises no_reviewer signal when only reviewers with matching model are available", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission matching model only");
    resetReviewRoutingSignals();
    const authorAgentId = randomUUID();
    const sameModelReviewerId = randomUUID();
    await ctx.db.insert(agents).values([
      {
        id: authorAgentId,
        companyId,
        name: "Issue Author",
        metadata: { telegramGroup: "dev" },
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "model-a" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: sameModelReviewerId,
        companyId,
        name: "Same Model Reviewer",
        metadata: { telegramGroup: "dev" },
        role: "reviewer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "model-a" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Matching model only",
      status: "todo",
      priority: "medium",
      createdByAgentId: authorAgentId,
    });

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(res.body.assigneeAgentId).toBeNull();
    expect(readReviewRoutingSignals(companyId).filter((signal) => signal.issueId === issueId)).toHaveLength(1);
  });

  it("rolls back review transition and does not leave issue in_review when wake persistence fails", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Review admission rollback");
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Reviewer Agent",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const stageId = randomUUID();
    const policy = {
      stages: [
        {
          id: stageId,
          type: "review" as const,
          participants: [{ type: "agent" as const, agentId: reviewerAgentId }],
        },
      ],
    };

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Atomic review admission rollback path",
      status: "todo",
      priority: "medium",
      executionPolicy: policy,
    });

    const failingIssueRoutes = (db: any, storage: any) =>
      issueRoutes(db, storage, {
        insertReviewAdmissionWakeup: async () => {
          throw new Error("simulated wake persistence failure during PATCH");
        },
      });

    const res = await request(routeApp(ctx.db, actor, failingIssueRoutes as any))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_review",
        executionPolicy: policy,
      });

    expect(res.status).toBe(500);

    const [issueRow] = await ctx.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueRow?.status).toBe("todo");

    const wakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          reviewAdmissionDedupKey({ issueId, headSha: null, agentId: reviewerAgentId }),
        ),
      );
    expect(wakes).toHaveLength(0);
  });

  it("directly verifies production helper insertReviewAdmissionWakeup commits atomically with tx", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Direct helper test");
    const reviewerAgentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Direct Helper Reviewer",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Direct helper issue",
      status: "todo",
      priority: "medium",
    });

    const heartbeat = heartbeatService(ctx.db);
    const key = `issue-review-admission:${issueId}:${reviewerAgentId}`;

    await ctx.db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
      const res = await heartbeat.insertReviewAdmissionWakeup(
        reviewerAgentId,
        {
          source: "assignment",
          reason: "execution_review_requested",
          payload: { issueId },
          idempotencyKey: key,
        },
        tx as any,
        companyId,
      );
      expect(res.created).toBe(true);
    });

    const [issueRow] = await ctx.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueRow?.status).toBe("in_review");

    const wakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, key));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("queued");
  });
});
