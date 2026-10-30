// myrmidon(OPE-10045): route-level tests of the review stage around recovery.
//
//  - A reviewer approves the last stage (`PATCH status=done` + comment) while
//    the PR is still open: the approval is recorded, the stage completes and
//    the task stays `in_review` until the PR sync closes it after the merge.
//  - The operator returns a blocked review task to `in_review`: the pending
//    stage is kept (or the re-sent policy's stage is started) and the
//    participant is woken, so nobody has to submit the work again.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issueWorkProducts,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review stage recovery route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Only dispatch is replaced: the fixture must not launch real runs. The
// review-admission wake is still written to the database by the real service.
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: async () => null,
    }),
  };
});

const PR_URL = "https://github.com/acme/app/pull/1830";

describeEmbeddedPostgres("review stage recovery (route level)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-review-stage-recovery-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seed(input: { status: "in_review" | "blocked"; pullRequestStatus?: string | null }) {
    const companyId = randomUUID();
    const engineerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const otherReviewerAgentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const issuePrefix = `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Myrmidon",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [
        [engineerAgentId, "Engineer"],
        [reviewerAgentId, "Reviewer"],
        [otherReviewerAgentId, "SecondReviewer"],
      ].map(([id, name]) => ({
        id: id!,
        companyId,
        name: name!,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: reviewerAgentId,
      status: "running",
      invocationSource: "automation",
      startedAt: new Date(),
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId, wakeReason: "execution_review_requested" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board lags behind PR statuses",
      status: input.status,
      priority: "high",
      assigneeAgentId: reviewerAgentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      ...(input.status === "in_review"
        ? {
            executionRunId: runId,
            executionAgentNameKey: "reviewer",
            executionLockedAt: new Date(),
          }
        : {}),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId, userId: null }],
          },
        ],
      },
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
        monitor: null,
        changesRequestedCount: 0,
      },
    });
    if (input.pullRequestStatus) {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "pull_request",
        provider: "github",
        title: "PR #1830",
        url: PR_URL,
        status: input.pullRequestStatus,
        isPrimary: true,
        metadata: { repo: "acme/app", number: 1830, state: input.pullRequestStatus },
      });
    }
    return { companyId, engineerAgentId, reviewerAgentId, otherReviewerAgentId, runId, issueId, stageId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function reviewerActor(s: Seeded): Express.Request["actor"] {
    return {
      type: "agent",
      agentId: s.reviewerAgentId,
      companyId: s.companyId,
      runId: s.runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: true,
      source: "session",
    };
  }

  async function readIssue(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return issue!;
  }

  it("records an approval given before the PR is merged and keeps the task in review", async () => {
    const s = await seed({ status: "in_review", pullRequestStatus: "open" });

    const res = await request(createApp(reviewerActor(s)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "done", comment: "APPROVE PR #1830: the head is green, the fix is correct." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewApproval).toMatchObject({
      code: "review_approval_pending_merge",
      recorded: true,
      pendingMerge: true,
      pullRequestUrl: PR_URL,
    });
    expect(res.body.reviewApproval.message).toContain("Одобрение записано");

    const issue = await readIssue(s.issueId);
    expect(issue.status).toBe("in_review");
    expect(issue.executionState).toMatchObject({
      status: "completed",
      lastDecisionOutcome: "approved",
      completedStageIds: [s.stageId],
    });
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, s.issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      stageId: s.stageId,
      outcome: "approved",
      actorAgentId: s.reviewerAgentId,
    });
    expect((issue.executionState as Record<string, unknown>).lastDecisionId).toBe(decisions[0]!.id);
  });

  it("keeps an approval comment and its decision while the PR is open", async () => {
    const s = await seed({ status: "in_review", pullRequestStatus: "open" });

    const res = await request(createApp(reviewerActor(s)))
      .post(`/api/issues/${s.issueId}/comments`)
      .send({ body: "## Review: APPROVED\n\nThe head is green and the fix is correct." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const issue = await readIssue(s.issueId);
    expect(issue.status).toBe("in_review");
    expect(issue.executionState).toMatchObject({ status: "completed", lastDecisionOutcome: "approved" });
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, s.issueId));
    expect(decisions.map((decision) => decision.outcome)).toEqual(["approved"]);
  });

  it("closes the task as before when the PR is already merged", async () => {
    const s = await seed({ status: "in_review", pullRequestStatus: "merged" });

    const res = await request(createApp(reviewerActor(s)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "done", comment: "APPROVE: merged and verified." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewApproval).toBeUndefined();
    expect((await readIssue(s.issueId)).status).toBe("done");
  });

  it("starts the re-sent policy's review stage when the operator returns a blocked task to review", async () => {
    const s = await seed({ status: "blocked", pullRequestStatus: "open" });

    const res = await request(createApp(boardActor(s.companyId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({
        status: "in_review",
        executionPolicy: {
          mode: "normal",
          stages: [{ type: "review", participants: [{ type: "agent", agentId: s.otherReviewerAgentId }] }],
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const issue = await readIssue(s.issueId);
    expect(issue.status).toBe("in_review");
    expect(issue.assigneeAgentId).toBe(s.otherReviewerAgentId);
    expect(issue.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: s.otherReviewerAgentId },
      returnAssignee: { type: "agent", agentId: s.engineerAgentId },
    });
    const stageId = (issue.executionState as Record<string, unknown>).currentStageId;
    expect(stageId).not.toBe(s.stageId);
    expect((issue.executionPolicy as { stages: Array<{ id: string }> }).stages[0]!.id).toBe(stageId);
  });

  it("keeps the pending stage and wakes the participant when the operator returns a blocked task to review", async () => {
    const s = await seed({ status: "blocked", pullRequestStatus: "open" });

    const res = await request(createApp(boardActor(s.companyId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "in_review" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const issue = await readIssue(s.issueId);
    expect(issue.status).toBe("in_review");
    expect(issue.assigneeAgentId).toBe(s.reviewerAgentId);
    expect(issue.executionState).toMatchObject({
      status: "pending",
      currentStageId: s.stageId,
      currentParticipant: { type: "agent", agentId: s.reviewerAgentId },
      returnAssignee: { type: "agent", agentId: s.engineerAgentId },
    });
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, s.reviewerAgentId),
          eq(agentWakeupRequests.reason, "execution_review_requested"),
        ),
      );
    expect(wakes.length).toBeGreaterThan(0);
  });
});
