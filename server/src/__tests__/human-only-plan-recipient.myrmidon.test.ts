import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { expect, it } from "vitest";
import { agents, documentRevisions, documents, heartbeatRuns, issueDocuments, issues, issueThreadInteractions } from "@myrmidon/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("human-only plan confirmation recipient", () => {
  const ctx = useEmbeddedPostgres("human-only-plan-recipient-");

  async function seed() {
    const { companyId, userId } = await seedCompanyWithBoardAccess(ctx.db, "Synthetic plan");
    const issueId = randomUUID();
    const agentId = randomUUID();
    const leadId = randomUUID();
    const leadRunId = randomUUID();
    const runId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await ctx.db.insert(agents).values([
      { id: leadId, companyId, name: "Synthetic lead", role: "lead", status: "active" },
      { id: agentId, companyId, name: "Synthetic author", role: "engineer", status: "active", reportsTo: leadId },
    ]);
    await ctx.db.insert(heartbeatRuns).values([{ id: runId, companyId, agentId, invocationSource: "manual", status: "running" }, { id: leadRunId, companyId, agentId: leadId, invocationSource: "manual", status: "running" }]);
    await ctx.db.insert(issues).values({ id: issueId, companyId, title: "Synthetic issue", status: "in_progress", assigneeAgentId: agentId, executionRunId: runId });
    await ctx.db.insert(documents).values({ id: documentId, companyId, title: "Plan", format: "markdown", latestBody: "# Plan", latestRevisionId: revisionId, latestRevisionNumber: 1 });
    await ctx.db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan" });
    await ctx.db.insert(documentRevisions).values({ id: revisionId, companyId, documentId, revisionNumber: 1, title: "Plan", format: "markdown", body: "# Plan" });
    const target = { type: "issue_document" as const, issueId, documentId, key: "plan", revisionId, revisionNumber: 1 };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "agent", agentId, companyId, runId }; next(); });
    app.use("/api", issueRoutes(ctx.db, {} as never));
    app.use(errorHandler);
    return { companyId, userId, issueId, agentId, leadId, leadRunId, target, app };
  }

  it.each(["explicit", "owner fallback"])("routes %s to a human through HTTP and persists the recipient", async (mode) => {
    const s = await seed();
    const body = { kind: "request_confirmation", resolverPolicy: "human_only", idempotencyKey: `confirmation:${s.issueId}:plan:${s.target.revisionId}`, ...(mode === "explicit" ? { addresseeUserId: s.userId } : {}), payload: { version: 1, prompt: "Approve the plan?", target: s.target } };
    const response = await request(s.app).post(`/api/issues/${s.issueId}/interactions`).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [row] = await ctx.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, response.body.id));
    expect(row).toMatchObject({ status: "pending", effectiveResolverPolicy: "human_only", addresseeUserId: s.userId, addresseeAgentId: null, routeType: "human_input" });
    const retry = await request(s.app).post(`/api/issues/${s.issueId}/interactions`).send(body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.id).toBe(response.body.id);
    const svc = issueThreadInteractionService(ctx.db);
    await expect(svc.acceptInteraction({ id: s.issueId, companyId: s.companyId, goalId: null, projectId: null }, row.id, {}, { agentId: s.leadId, runId: s.leadRunId })).rejects.toMatchObject({ status: 403 });
    await expect(svc.rejectInteraction({ id: s.issueId, companyId: s.companyId }, row.id, { reason: "No" }, { agentId: s.leadId, runId: s.leadRunId })).rejects.toMatchObject({ status: 403 });
  });

  it("retains engineering routing and rejects stale targets", async () => {
    const s = await seed();
    const svc = issueThreadInteractionService(ctx.db);
    const input = { kind: "request_confirmation" as const, resolverPolicy: "not_creator" as const, idempotencyKey: `plan:${s.target.revisionId}`, payload: { version: 1 as const, prompt: "Approve?", target: s.target } };
    const first = await svc.create({ id: s.issueId, companyId: s.companyId }, input, { agentId: s.agentId });
    expect(first.addresseeAgentId).toBe(s.leadId);
    expect(first.addresseeAgentId).not.toBe(s.agentId);
    expect((await svc.create({ id: s.issueId, companyId: s.companyId }, input, { agentId: s.agentId })).id).toBe(first.id);
    await expect(svc.create({ id: s.issueId, companyId: s.companyId }, { ...input, idempotencyKey: randomUUID(), payload: { ...input.payload, target: { ...s.target, revisionId: randomUUID() } } }, { agentId: s.agentId })).rejects.toMatchObject({ status: 422 });
  });
});
