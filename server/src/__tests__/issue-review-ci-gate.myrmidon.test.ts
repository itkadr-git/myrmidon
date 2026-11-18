import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { agents, connectionEventDeliveries, heartbeatRuns, issueWorkProducts, issues, toolGatewayRateLimitCounters } from "@myrmidon/db";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import { issueRoutes } from "../routes/issues.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { resetReviewCiCacheForTests } from "../myrmidon/review-stage-recovery/github-ci.js";
import { resetGitHubRateLimitForTests } from "../services/github-rate-limit.js";

const transport = vi.hoisted(() => vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
  throw new Error("Unexpected external transport");
}));
vi.mock("../services/github-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/github-fetch.js")>(),
  ghFetch: transport,
}));
vi.mock("../services/github-external-object-provider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/github-external-object-provider.js")>(),
  defaultTokenProvider: async () => null,
}));

const ctx = useEmbeddedPostgres("myrmidon-review-ci-gate-");

describeEmbeddedPostgres("real PATCH review CI gate with isolated transport", () => {
  beforeEach(() => {
    transport.mockClear();
    resetReviewCiCacheForTests();
    resetGitHubRateLimitForTests();
  });

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(ctx.db, heartbeatService(ctx.db));
  });

  it("rejects unavailable CI at 2000 without a GitHub call and accepts matching fresh success", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Isolated CI write gate");
    const author = randomUUID();
    const reviewer = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const stageId = randomUUID();
    const headSha = "a".repeat(40);
    const base = { companyId, status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} };
    await ctx.db.insert(agents).values([
      { ...base, id: author, name: "Author", role: "engineer" },
      { ...base, id: reviewer, name: "Reviewer", role: "reviewer" },
    ]);
    const policy = { mode: "normal", stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewer, userId: null }] }] };
    await ctx.db.insert(issues).values({
      id: issueId, companyId, title: "Isolated write gate", status: "in_review", priority: "medium",
      createdByAgentId: author, assigneeAgentId: author, executionPolicy: policy,
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer, userId: null }, returnAssignee: { type: "agent", agentId: author, userId: null }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null },
    });
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewer, status: "succeeded", contextSnapshot: { issueId } });
    await ctx.db.insert(issueWorkProducts).values({ companyId, issueId, type: "pull_request", provider: "github", title: "Synthetic PR", url: "https://github.com/acme/app/pull/7", status: "open", isPrimary: true, metadata: { repo: "acme/app", number: 7, headSha } });
    const [clock] = await ctx.db.execute(sql`select floor(extract(epoch from clock_timestamp()) / 60)::bigint as minute`);
    const minute = Number(clock?.minute);
    const start = new Date(minute * 60_000);
    await ctx.db.insert(toolGatewayRateLimitCounters).values({ companyId, counterKey: `github-budget:review-rework:${minute}`, windowStartAt: start, windowMs: 60_000, limit: 2000, count: 2000, resetAt: new Date(start.getTime() + 3_600_000) });
    const actor = { type: "agent", agentId: reviewer, companyId, source: "agent_key", runId };
    const app = routeApp(ctx.db, actor as never, issueRoutes);
    const rejected = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI is unavailable" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    expect(JSON.stringify(rejected.body)).toContain("CI status for the current pull request head is unavailable");
    expect(transport).not.toHaveBeenCalled();
    const [unchanged] = await ctx.db.select().from(issues).where(sql`${issues.id} = ${issueId}`);
    expect(unchanged?.status).toBe("in_review");

    const stale = new Date(Date.now() - 31 * 60_000);
    await ctx.db.insert(connectionEventDeliveries).values([
      { companyId, provider: "github", providerDeliveryId: "stale-pr", event: "pull_request", status: "processed", createdAt: stale, normalizedPayload: { repository: "acme/app", number: 7, state: "open", headSha } },
      { companyId, provider: "github", providerDeliveryId: "stale-check", event: "check_run", status: "processed", createdAt: stale, normalizedPayload: { repository: "acme/app", number: 7, headSha, checkName: "CI result", status: "completed", conclusion: "success" } },
    ]);
    const staleResult = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI is unavailable" });
    expect(staleResult.status, JSON.stringify(staleResult.body)).toBe(422);
    expect(transport).not.toHaveBeenCalled();

    await ctx.db.insert(connectionEventDeliveries).values([
      { companyId, provider: "github", providerDeliveryId: "moved-pr", event: "pull_request", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, state: "open", headSha: "b".repeat(40) } },
      { companyId, provider: "github", providerDeliveryId: "moved-check", event: "check_run", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, headSha: "b".repeat(40), checkName: "CI result", status: "completed", conclusion: "success" } },
    ]);
    const movedResult = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI is unavailable" });
    expect(movedResult.status, JSON.stringify(movedResult.body)).toBe(422);
    expect(transport).not.toHaveBeenCalled();

    await ctx.db.delete(connectionEventDeliveries).where(sql`${connectionEventDeliveries.companyId} = ${companyId}`);
    await ctx.db.insert(connectionEventDeliveries).values([
      { companyId, provider: "github", providerDeliveryId: "synthetic-pr", event: "pull_request", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, state: "open", headSha } },
      { companyId, provider: "github", providerDeliveryId: "synthetic-check", event: "check_run", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, headSha, checkName: "CI result", status: "completed", conclusion: "success" } },
    ]);
    const accepted = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI is unavailable" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.status).toBe("in_progress");
    expect(transport).not.toHaveBeenCalled();
  });
});
