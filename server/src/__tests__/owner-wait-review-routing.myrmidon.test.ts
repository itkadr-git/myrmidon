import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { agents, documentRevisions, documents, heartbeatRuns, issueDocuments, issueExecutionDecisions, issueThreadInteractions, issues } from "@myrmidon/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

const wakeup = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({ ...actual.heartbeatService(...args), wakeup }) };
});

describeEmbeddedPostgres("owner wait review routing", () => {
  const ctx = useEmbeddedPostgres("owner-wait-review-");

  it("rejects a drifted non-reviewer's blocked request without changing the issue or recording a decision", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Synthetic owner wait");
    const engineer = randomUUID();
    const reviewer = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const runId = randomUUID();
    await ctx.db.insert(agents).values([
      { id: engineer, companyId, name: "Synthetic engineer", role: "engineer", status: "active", metadata: { telegramGroup: "synthetic" } },
      { id: reviewer, companyId, name: "Synthetic reviewer", role: "reviewer", status: "active", metadata: { telegramGroup: "synthetic" } },
    ]);
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: engineer, invocationSource: "manual", status: "running", contextSnapshot: { issueId } });
    await ctx.db.insert(issues).values({
      id: issueId, companyId, title: "Synthetic owner wait", status: "in_review", assigneeAgentId: engineer, executionRunId: runId,
      executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewer }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer }, returnAssignee: { type: "agent", agentId: engineer }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: null, changesRequestedCount: 0 },
    });
    const [before] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "agent", agentId: engineer, companyId, runId }; next(); });
    app.use("/api", issueRoutes(ctx.db, {} as never));
    app.use(errorHandler);
    const response = await request(app).patch(`/api/issues/${issueId}`).set("X-Paperclip-Run-Id", runId).send({ status: "blocked" });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toContain("Only the active reviewer or approver");
    const [after] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(after).toEqual(before);
    expect(await ctx.db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId))).toHaveLength(0);
  });

  it("lets the board block a drifted review while explicitly clearing its monitor and retaining its blocker and executor", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Synthetic operator block");
    const engineer = randomUUID();
    const reviewer = randomUUID();
    const issueId = randomUUID();
    const blockerId = randomUUID();
    const stageId = randomUUID();
    const nextCheckAt = new Date(Date.now() + 3600000).toISOString();
    const stages = [{ id: stageId, type: "review" as const, approvalsNeeded: 1, participants: [{ type: "agent" as const, agentId: reviewer }] }];
    await ctx.db.insert(agents).values([
      { id: engineer, companyId, name: "Synthetic engineer", role: "engineer", status: "active" },
      { id: reviewer, companyId, name: "Synthetic reviewer", role: "reviewer", status: "active" },
    ]);
    await ctx.db.insert(issues).values([
      { id: blockerId, companyId, title: "Synthetic dependency", status: "todo" },
      { id: issueId, companyId, title: "Synthetic review", status: "in_review", assigneeAgentId: engineer, monitorNextCheckAt: new Date(nextCheckAt),
        executionPolicy: { mode: "normal", stages, monitor: { nextCheckAt, scheduledBy: "board" } },
        executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer }, returnAssignee: { type: "agent", agentId: engineer }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: null, changesRequestedCount: 0 } },
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId, companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(ctx.db, {} as never));
    app.use(errorHandler);
    const response = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked", assigneeAgentId: engineer, blockedByIssueIds: [blockerId], blockerMetadata: { blockReason: "dependency", owner: { agentId: engineer }, blockedByIssueIds: [blockerId], nextCheckAt, timeoutAt: new Date(Date.now() + 7200000).toISOString(), escalationPolicy: "notify_owner" }, executionPolicy: { mode: "normal", stages } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: "blocked", assigneeAgentId: engineer, monitorNextCheckAt: null });
    const [after] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(after.status).toBe("blocked");
    expect(after.assigneeAgentId).toBe(engineer);
    expect(after.monitorNextCheckAt).toBeNull();
    expect(after.executionState).not.toMatchObject({ status: "pending" });
    expect(await ctx.db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId))).toHaveLength(0);
    const relations = await request(app).get(`/api/issues/${issueId}`);
    expect(JSON.stringify(relations.body)).toContain(blockerId);
  });

  it("still permits the active technical reviewer to request changes", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Synthetic technical review");
    const engineer = randomUUID(), reviewer = randomUUID(), issueId = randomUUID(), stageId = randomUUID(), runId = randomUUID();
    await ctx.db.insert(agents).values([
      { id: engineer, companyId, name: "Synthetic engineer", role: "engineer", status: "active" },
      { id: reviewer, companyId, name: "Synthetic reviewer", role: "reviewer", status: "active" },
    ]);
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewer, invocationSource: "manual", status: "running", contextSnapshot: { issueId } });
    await ctx.db.insert(issues).values({ id: issueId, companyId, title: "Synthetic technical review", status: "in_review", assigneeAgentId: reviewer, executionRunId: runId,
      executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewer }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer }, returnAssignee: { type: "agent", agentId: engineer }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: null, changesRequestedCount: 0 } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "agent", agentId: reviewer, companyId, runId }; next(); });
    app.use("/api", issueRoutes(ctx.db, {} as never));
    app.use(errorHandler);
    const response = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "Please correct the synthetic issue." });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: "in_progress", assigneeAgentId: engineer });
    expect(await ctx.db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId))).toHaveLength(1);
  });

  it("links a human-only confirmation without starting technical review and rejects agent resolution", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Synthetic owner confirmation");
    const issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID();
    await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Synthetic engineer", role: "engineer", status: "active" });
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running", contextSnapshot: { issueId } });
    await ctx.db.insert(issues).values({ id: issueId, companyId, title: "Synthetic owner wait", status: "in_progress", assigneeAgentId: agentId, executionRunId: runId });
    await ctx.db.insert(documents).values({ id: documentId, companyId, title: "Plan", format: "markdown", latestBody: "# Plan", latestRevisionId: revisionId, latestRevisionNumber: 1 });
    await ctx.db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan" });
    await ctx.db.insert(documentRevisions).values({ id: revisionId, companyId, documentId, revisionNumber: 1, title: "Plan", format: "markdown", body: "# Plan" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = req.headers["x-board"] ? { type: "board", userId, companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true } : { type: "agent", agentId, companyId, runId }; next(); });
    app.use("/api", issueRoutes(ctx.db, {} as never));
    app.use(errorHandler);
    const created = await request(app).post(`/api/issues/${issueId}/interactions`).send({ kind: "request_confirmation", resolverPolicy: "human_only", idempotencyKey: `confirmation:${issueId}:plan:${revisionId}`, payload: { version: 1, prompt: "Approve?", target: { type: "issue_document", issueId, documentId, key: "plan", revisionId, revisionNumber: 1 } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    wakeup.mockClear();
    const review = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_review", reviewInteractionId: created.body.id });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const [waiting] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(waiting).toMatchObject({ status: "in_review", assigneeAgentId: agentId, monitorNextCheckAt: null });
    expect(waiting.executionState).toBeNull();
    expect(wakeup).not.toHaveBeenCalled();
    expect(await ctx.db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId))).toHaveLength(0);
    const denied = await request(app).post(`/api/issues/${issueId}/interactions/${created.body.id}/accept`).send({});
    expect(denied.status).toBe(403);
    const [pending] = await ctx.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, created.body.id));
    expect(pending.status).toBe("pending");
    const accepted = await request(app).post(`/api/issues/${issueId}/interactions/${created.body.id}/accept`).set("x-board", "yes").send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const [resolved] = await ctx.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, created.body.id));
    expect(resolved.status).toBe("accepted");
    const [resumed] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(resumed).toMatchObject({ status: "todo", assigneeAgentId: agentId });
  });
});
