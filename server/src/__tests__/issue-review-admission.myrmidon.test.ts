import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
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
import { REVIEW_CI_WAIT_MONITOR_SERVICE_NAME } from "../myrmidon/review-stage-recovery/policy.js";
import { readReviewRoutingSignals, resetReviewRoutingSignals } from "../myrmidon/review-routing/attention.js";

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
    const pendingCiRoutes = (db: any, storage: any, options?: any) => issueRoutes(db, storage, {
      ...options,
      resolveReviewPullRequestCi: async () => ({ state: "pending", pullRequestUrl: "https://github.com/acme/app/pull/7", headSha: "head-abc" }),
    });

    const response = await request(routeApp(ctx.db, actor, pendingCiRoutes as any))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", executionPolicy: policy });

    expect(response.status).toBe(200);
    const wakes = await ctx.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `issue-review-admission:${issueId}:${reviewerAgentId}`));
    expect(wakes).toHaveLength(0);
    const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.executionPolicy).toMatchObject({ monitor: { serviceName: REVIEW_CI_WAIT_MONITOR_SERVICE_NAME } });
    expect(issue?.monitorNextCheckAt).toBeInstanceOf(Date);
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
    const unreadableCiRoutes = (db: any, storage: any, options?: any) => issueRoutes(db, storage, {
      ...options,
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
      .where(eq(agentWakeupRequests.idempotencyKey, `issue-review-admission:${issueId}:${reviewerAgentId}`));
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

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
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
          `issue-review-admission:${issueId}:${reviewerAgentId}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.companyId).toBe(companyId);
    expect(wakes[0]?.agentId).toBe(reviewerAgentId);
    expect(wakes[0]?.reason).toBe("execution_review_requested");
    expect(wakes[0]?.status).toBe("queued");
    expect(wakes[0]?.payload).toMatchObject({ issueId });
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
      .where(eq(agentWakeupRequests.idempotencyKey, `issue-review-admission:${issueId}:${selectedReviewerId}`));
    expect(wakes).toHaveLength(1);
    const rejectedCandidateWakes = await ctx.db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `issue-review-admission:${issueId}:${sameModelReviewerId}`));
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
          `issue-review-admission:${issueId}:${reviewerAgentId}`,
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
