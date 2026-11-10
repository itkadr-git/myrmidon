import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companySkills,
  heartbeatRunEvents,
  heartbeatRuns,
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
import {
  SELF_CHECK_REJECT_CODES,
  type SelfCheckEvidenceDeps,
} from "../myrmidon/self-check-gate/index.js";
import type { PullRequestHeadLaneEvidence } from "../services/github-pull-request-ci.js";

type RouteDb = Parameters<typeof issueRoutes>[0];
type RouteStorage = Parameters<typeof issueRoutes>[1];

const HEAD_SHA = "42c79c5da4327601f290f72623c4fa0dbb3e4eb8";

const ctx = useEmbeddedPostgres("myrmidon-self-check-gate-routes-", {
  resetEach: async (db) => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.transaction(async (tx) => {
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

async function seedAgentIssueFixture(overrides?: {
  executionState?: Record<string, unknown>;
}) {
  const { companyId } = await seedCompanyWithBoardAccess(
    ctx.db,
    "Self-check gate routes",
  );
  const engineerAgentId = randomUUID();
  const reviewerAgentId = randomUUID();
  await ctx.db.insert(agents).values([
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
    mode: "normal" as const,
    stages: [
      {
        id: stageId,
        type: "review" as const,
        approvalsNeeded: 1,
        participants: [
          {
            id: randomUUID(),
            type: "agent" as const,
            agentId: reviewerAgentId,
            userId: null,
          },
        ],
      },
    ],
  };

  const issueId = randomUUID();
  await ctx.db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Self-check gate test issue",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: engineerAgentId,
    executionPolicy: policy,
    executionState: overrides?.executionState ?? null,
  });
  const runId = randomUUID();
  await ctx.db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId: engineerAgentId,
    status: "running",
    // Real heartbeat runs carry their source issue; the cross-issue influence
    // cap requires it to attribute the write (matches readRunSourceIssueId).
    contextSnapshot: { issueId },
  });

  const agentActor = {
    type: "agent" as const,
    source: "agent_jwt" as const,
    agentId: engineerAgentId,
    companyId,
    runId,
    isInstanceAdmin: false,
  };

  return {
    companyId,
    issueId,
    engineerAgentId,
    reviewerAgentId,
    agentActor,
    policy,
  };
}

function makeEvidenceDeps(overrides: {
  changedFiles?: number | null;
  additions?: number | null;
  deletions?: number | null;
  testState?: "success" | "failure";
  lintState?: "success" | "failure";
  testLane?: Pick<PullRequestHeadLaneEvidence, "state" | "status" | "conclusion" | "finishedAt" | "headSha">;
}): SelfCheckEvidenceDeps {
  const nowIso = new Date().toISOString();
  const makeLane = (
    lane: "test" | "lint",
    state: "success" | "failure",
  ): PullRequestHeadLaneEvidence => ({
    lane,
    name: lane,
    headSha: HEAD_SHA,
    state,
    status: "completed",
    conclusion: state,
    finishedAt: nowIso,
  });

  return {
    resolvePullRequestTarget: async () => ({
      kind: "ok",
      pullRequestUrl: "https://github.com/acme/app/pull/42",
      reference: { host: "github.com", owner: "acme", repo: "app", number: 42 },
    }),
    resolvePullRequestDetails: async () => ({
      headSha: HEAD_SHA,
      changedFiles: overrides.changedFiles === undefined ? 3 : overrides.changedFiles,
      additions: overrides.additions === undefined ? 50 : overrides.additions,
      deletions: overrides.deletions === undefined ? 10 : overrides.deletions,
    }),
    resolveHeadLaneEvidence: async () => {
      const test = overrides.testLane
        ? { lane: "test" as const, name: "test", ...overrides.testLane }
        : makeLane("test", overrides.testState ?? "success");
      return [test, makeLane("lint", overrides.lintState ?? "success")];
    },
  };
}

describeEmbeddedPostgres("myrmidon self-check gate routes", () => {
  it("пустой дифф -> 422, admission нет, статус остался in_progress, причина в комментарии", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture();
    const insertReviewAdmissionWakeup = vi.fn(async () => ({ created: true }));

    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        selfCheckEvidenceDeps: makeEvidenceDeps({
          changedFiles: 0,
          additions: 0,
          deletions: 0,
        }),
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: "https://github.com/acme/app/pull/42",
          headSha: HEAD_SHA,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup,
      });

    const response = await request(routeApp(ctx.db, agentActor as never, routes as never))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.code).toBe(SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    expect(insertReviewAdmissionWakeup).not.toHaveBeenCalled();

    const [updatedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");
    const executionState = updatedIssue?.executionState as Record<string, unknown> | null;
    expect(executionState?.selfCheckGateRejections).toBe(1);

    const comments = await ctx.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.length).toBeGreaterThanOrEqual(1);
    expect(comments.some((c: { body: string }) => c.body.includes("EMPTY_DIFF"))).toBe(true);
  });

  it("зелёные доказательства -> 200, status in_review, admission есть", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture();
    const insertReviewAdmissionWakeup = vi.fn(async () => ({ created: true }));

    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        selfCheckEvidenceDeps: makeEvidenceDeps({
          changedFiles: 2,
          additions: 25,
          deletions: 5,
          testState: "success",
          lintState: "success",
        }),
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: "https://github.com/acme/app/pull/42",
          headSha: HEAD_SHA,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup,
      });

    const response = await request(routeApp(ctx.db, agentActor as never, routes as never))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("in_review");
    expect(insertReviewAdmissionWakeup).toHaveBeenCalledTimes(1);

    const [updatedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_review");
  });

  it("три технических отказа -> admission с пометкой «гейт не пройден, см. причины»", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture();
    const insertReviewAdmissionWakeup = vi.fn(async () => ({ created: true }));

    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        selfCheckEvidenceDeps: makeEvidenceDeps({
          changedFiles: 2,
          additions: 25,
          deletions: 5,
          testState: "failure",
          lintState: "success",
        }),
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: "https://github.com/acme/app/pull/42",
          headSha: HEAD_SHA,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup,
      });

    const app = routeApp(ctx.db, agentActor as never, routes as never);

    // 3 technical failures -> each returns 422 and status stays in_progress
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_review" });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(SELF_CHECK_REJECT_CODES.TEST_FAILED);
      expect(insertReviewAdmissionWakeup).not.toHaveBeenCalled();

      const [issueAfterReject] = await ctx.db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId));
      expect(issueAfterReject?.status).toBe("in_progress");
      const executionState = issueAfterReject?.executionState as Record<string, unknown> | null;
      expect(executionState?.selfCheckGateRejections).toBe(attempt);
    }

    // 4th attempt after 3 failures -> admitted with note
    const admittedRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(admittedRes.status).toBe(200);
    expect(admittedRes.body.status).toBe("in_review");
    expect(insertReviewAdmissionWakeup).toHaveBeenCalledTimes(1);

    const [admittedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(admittedIssue?.status).toBe("in_review");
    const admittedExecutionState = admittedIssue?.executionState as Record<string, unknown> | null;
    expect(admittedExecutionState?.selfCheckGateBypassed).toBe(true);
    expect(typeof admittedExecutionState?.selfCheckGateNote === "string" && (admittedExecutionState.selfCheckGateNote as string).includes("гейт не пройден, см. причины")).toBe(true);

    const comments = await ctx.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(
      comments.some((c: { body: string }) => c.body.includes("гейт не пройден, см. причины")),
    ).toBe(true);
  });

  it("пустой дифф не пропускается никогда — даже после превышения лимита технических отказов", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture({
      executionState: { selfCheckGateRejections: 5 },
    });
    const insertReviewAdmissionWakeup = vi.fn(async () => ({ created: true }));

    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        selfCheckEvidenceDeps: makeEvidenceDeps({
          changedFiles: 0,
          additions: 0,
          deletions: 0,
        }),
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: "https://github.com/acme/app/pull/42",
          headSha: HEAD_SHA,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup,
      });

    const response = await request(routeApp(ctx.db, agentActor as never, routes as never))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe(SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    expect(insertReviewAdmissionWakeup).not.toHaveBeenCalled();

    const [updatedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");
  });

  it("нет PR-ворк-продукта -> 200 admission: гейт связывает только поставки с PR", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture();
    const insertReviewAdmissionWakeup = vi.fn(async () => ({ created: true }));

    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        selfCheckEvidenceDeps: {
          resolvePullRequestTarget: async () => ({ kind: "none" }),
          resolvePullRequestDetails: async () => {
            throw new Error("not_under_test");
          },
          resolveHeadLaneEvidence: async () => {
            throw new Error("not_under_test");
          },
        },
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: null,
          headSha: null,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup,
      });

    const response = await request(routeApp(ctx.db, agentActor as never, routes as never))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("in_review");
    expect(insertReviewAdmissionWakeup).toHaveBeenCalledTimes(1);

    const [updatedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_review");
  });
  it("пустой дифф с PENDING-дорожкой -> 422 EMPTY_DIFF, а не технический отказ с обходом", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture({
      executionState: { selfCheckGateRejections: 5 },
    });
    const insertReviewAdmissionWakeup = vi.fn(async () => ({ created: true }));

    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        selfCheckEvidenceDeps: makeEvidenceDeps({
          changedFiles: 0,
          additions: 0,
          deletions: 0,
          testLane: {
            state: "pending",
            status: "in_progress",
            conclusion: null,
            finishedAt: null,
            headSha: HEAD_SHA,
          },
        }),
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: "https://github.com/acme/app/pull/42",
          headSha: HEAD_SHA,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup,
      });

    const response = await request(routeApp(ctx.db, agentActor as never, routes as never))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe(SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    expect(insertReviewAdmissionWakeup).not.toHaveBeenCalled();

    const [updatedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");
    const executionState = updatedIssue?.executionState as Record<string, unknown> | null;
    expect(executionState?.selfCheckGateRejections).toBe(6);
    expect(executionState?.selfCheckGateBypassed).toBeUndefined();
  });
  it("пустой дифф после превышенного лимита -> жёсткий EMPTY_DIFF, не обход по счётчику", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture({
      executionState: { selfCheckGateRejections: 5 },
    });
    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        selfCheckEvidenceDeps: makeEvidenceDeps({
          changedFiles: 0,
          additions: 0,
          deletions: 0,
        }),
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: "https://github.com/acme/app/pull/42",
          headSha: HEAD_SHA,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup: vi.fn(async () => ({ created: true })),
      });

    const response = await request(routeApp(ctx.db, agentActor as never, routes as never))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe(SELF_CHECK_REJECT_CODES.EMPTY_DIFF);

    const [updatedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");
    const executionState = updatedIssue?.executionState as Record<string, unknown> | null;
    expect(executionState?.selfCheckGateRejections).toBe(6);
    expect(executionState?.selfCheckGateBypassed).toBeUndefined();
  });

  it("пустой дифф с нечитаемыми CI-дорожками -> 422 EMPTY_DIFF, а не UNKNOWN-обход", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture({
      executionState: { selfCheckGateRejections: 5 },
    });
    const insertReviewAdmissionWakeup = vi.fn(async () => ({ created: true }));

    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        selfCheckEvidenceDeps: {
          resolvePullRequestTarget: async () => ({
            kind: "ok",
            pullRequestUrl: "https://github.com/acme/app/pull/42",
            reference: { host: "github.com", owner: "acme", repo: "app", number: 42 },
          }),
          resolvePullRequestDetails: async () => ({
            headSha: HEAD_SHA,
            changedFiles: 0,
            additions: 0,
            deletions: 0,
          }),
          resolveHeadLaneEvidence: async () => {
            throw new Error("ci lanes unavailable");
          },
        },
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: "https://github.com/acme/app/pull/42",
          headSha: HEAD_SHA,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup,
      });

    const response = await request(routeApp(ctx.db, agentActor as never, routes as never))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe(SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    expect(insertReviewAdmissionWakeup).not.toHaveBeenCalled();

    const [updatedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");
    const executionState = updatedIssue?.executionState as Record<string, unknown> | null;
    expect(executionState?.selfCheckGateRejections).toBe(6);
    expect(executionState?.selfCheckGateBypassed).toBeUndefined();
  });

  it("упавший резолвер гейта -> 422 TEST_FAILED со счётчиком, а не 500 и не допуск", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture();
    const insertReviewAdmissionWakeup = vi.fn(async () => ({ created: true }));

    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        resolveSelfCheckGate: async () => {
          throw new Error("evidence storage degraded");
        },
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: "https://github.com/acme/app/pull/42",
          headSha: HEAD_SHA,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup,
      });

    const response = await request(routeApp(ctx.db, agentActor as never, routes as never))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe(SELF_CHECK_REJECT_CODES.TEST_FAILED);
    expect(insertReviewAdmissionWakeup).not.toHaveBeenCalled();

    const [updatedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");
    const executionState = updatedIssue?.executionState as Record<string, unknown> | null;
    expect(executionState?.selfCheckGateRejections).toBe(1);
  });

  it("нечисловой/отсутствующий дифф при зелёных проверках -> 422 EMPTY_DIFF, не байпасится", async () => {
    const { issueId, agentActor } = await seedAgentIssueFixture();
    const insertReviewAdmissionWakeup = vi.fn(async () => ({ created: true }));

    const routes = (db: RouteDb, storage: RouteStorage) =>
      issueRoutes(db, storage, {
        selfCheckEvidenceDeps: makeEvidenceDeps({
          changedFiles: null,
          additions: null,
          deletions: null,
          testState: "success",
          lintState: "success",
        }),
        resolveReviewPullRequestCi: async () => ({
          state: "complete",
          pullRequestUrl: "https://github.com/acme/app/pull/42",
          headSha: HEAD_SHA,
        }),
        resolveReviewHeadFailedChecks: async () => ({
          state: "unknown",
          reason: "not_under_test",
        }),
        insertReviewAdmissionWakeup,
      });

    const response = await request(routeApp(ctx.db, agentActor as never, routes as never))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe(SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    expect(insertReviewAdmissionWakeup).not.toHaveBeenCalled();

    const [updatedIssue] = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");
  });

});

