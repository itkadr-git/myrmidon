import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issueExecutionDecisions, issues } from "@myrmidon/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({ ...actual.heartbeatService(...args), wakeup: async () => null }) };
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
});
