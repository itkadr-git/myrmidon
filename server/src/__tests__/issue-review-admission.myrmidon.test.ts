import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  issues,
} from "@myrmidon/db";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { readReviewRoutingSignals, resetReviewRoutingSignals } from "../myrmidon/review-routing/attention.js";

// myrmidon(REVIEW-ADMISSION): issue transition to in_review and reviewer wake
// must be written in the same database transaction via PATCH /api/issues/:id.

const ctx = useEmbeddedPostgres("myrmidon-review-admission-", {
  resetEach: async (db) => {
    await db.transaction(async (tx) => {
      // Freeze writers to every table whose rows are drained below. The lock
      // mode conflicts with INSERT on these tables, so no dependent wake/activity
      // row can appear between cleanup statements and the agent delete.
      await tx.execute(
        sql`LOCK TABLE activity_log, agent_wakeup_requests, issues, agents IN SHARE ROW EXCLUSIVE MODE`,
      );
      await tx.delete(agentWakeupRequests);
      await tx.delete(activityLog);
      await tx.delete(issues);
      await tx.delete(agents);
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
    const assigned = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: reviewerAgentId });
    expect(assigned.status).toBe(200);
    expect(readReviewRoutingSignals(companyId).filter((signal) => signal.issueId === issueId)).toHaveLength(0);
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
