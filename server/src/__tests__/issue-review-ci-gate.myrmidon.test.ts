import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, connectionEventDeliveries, heartbeatRuns, issueWorkProducts, issues, toolGatewayRateLimitCounters } from "@myrmidon/db";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import { issueRoutes } from "../routes/issues.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { resetReviewCiCacheForTests } from "../myrmidon/review-stage-recovery/github-ci.js";
import { resetGitHubRateLimitForTests } from "../services/github-rate-limit.js";
import { logger } from "../middleware/logger.js";
import { clearCiCacheForTests, createPullRequestCiResolver, invalidateCiCacheForHead } from "../services/github-pull-request-ci.js";

const transport = vi.hoisted(() => vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
  throw new Error("Unexpected external transport");
}));
const canary = "synthetic-secret-do-not-log-15043";
const pullUrl = "https://api.github.com/repos/acme/app/pulls/7";
function unexpectedCalls(calls: Array<[string, RequestInit?]>, allowed: string[]) {
  return calls.filter(([url, init]) => !allowed.includes(url) || !JSON.stringify(init?.headers).includes(canary));
}
it("detects unexpected URLs and missing credentials outside the resolver", () => {
  expect(unexpectedCalls([["https://unexpected.invalid", { headers: { Authorization: canary } }]], [pullUrl])).toHaveLength(1);
  expect(unexpectedCalls([[pullUrl, { headers: {} }]], [pullUrl])).toHaveLength(1);
});
vi.mock("../services/github-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/github-fetch.js")>(),
  ghFetch: transport,
}));
vi.mock("../services/github-external-object-provider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/github-external-object-provider.js")>(),
  defaultTokenProvider: async () => canary,
}));

const ctx = useEmbeddedPostgres("myrmidon-review-ci-gate-");

describeEmbeddedPostgres("real PATCH review CI gate with isolated transport", () => {
  beforeEach(() => {
    transport.mockClear();
    resetReviewCiCacheForTests();
    clearCiCacheForTests();
    resetGitHubRateLimitForTests();
  });

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(ctx.db, heartbeatService(ctx.db));
    await ctx.db.delete(toolGatewayRateLimitCounters);
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
    const diagnostic = vi.spyOn(logger, "info");
    const warning = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    const rejected = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI is unavailable" });
    expect(diagnostic.mock.calls.some(([fields]) => typeof fields === "object" && fields !== null &&
      "issueId" in fields && fields.issueId === issueId && "runId" in fields && fields.runId === runId &&
      "reason" in fields && fields.reason === "budget_exhausted" &&
      "transportCalls" in fields && fields.transportCalls === 0 &&
      "budget" in fields && JSON.stringify(fields.budget) === JSON.stringify({ used: 2000, cap: 2000, windowMinutes: 60 }))).toBe(true);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    expect(JSON.stringify(rejected.body)).toContain("CI status for the current pull request head is unavailable");
    expect(transport).not.toHaveBeenCalled();
    const [unchanged] = await ctx.db.select().from(issues).where(sql`${issues.id} = ${issueId}`);
    expect(unchanged?.status).toBe("in_review");

    await ctx.db.update(toolGatewayRateLimitCounters).set({ count: 1999 }).where(sql`${toolGatewayRateLimitCounters.companyId} = ${companyId}`);
    transport.mockImplementationOnce(async () => {
      throw new Error(`synthetic transport failure ${canary}`);
    });
    const networkFailure = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI is unavailable" });
    expect(networkFailure.status).toBe(422);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls.map(([url]) => url)).toEqual([pullUrl]);
    expect(unexpectedCalls(transport.mock.calls, [pullUrl])).toEqual([]);
    expect(diagnostic.mock.calls.some(([fields]) => typeof fields === "object" && fields !== null &&
      "reason" in fields && fields.reason === "network_error" &&
      "budget" in fields && JSON.stringify(fields.budget) === JSON.stringify({ used: 2000, cap: 2000, windowMinutes: 60 }))).toBe(true);
    expect(JSON.stringify([diagnostic.mock.calls, warning.mock.calls, error.mock.calls, rejected.body, networkFailure.body])).not.toContain(canary);

    // One reservation can read the PR head, but cannot complete the subsequent CI reads.
    transport.mockClear();
    diagnostic.mockClear();
    await ctx.db.delete(toolGatewayRateLimitCounters).where(sql`${toolGatewayRateLimitCounters.companyId} = ${companyId}`);
    await ctx.db.insert(toolGatewayRateLimitCounters).values({ companyId, counterKey: `github-budget:review-rework:${minute}`, windowStartAt: start, windowMs: 60_000, limit: 2000, count: 1999, resetAt: new Date(start.getTime() + 3_600_000) });
    transport.mockImplementationOnce(async () => {
      return Response.json({ state: "open", head: { sha: headSha } });
    });
    const partial = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI is unavailable" });
    expect(partial.status).toBe(422);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls.map(([url]) => url)).toEqual([pullUrl]);
    expect(unexpectedCalls(transport.mock.calls, [pullUrl])).toEqual([]);
    expect(diagnostic.mock.calls.some(([fields]) => typeof fields === "object" && fields !== null &&
      "reason" in fields && fields.reason === "budget_exhausted" &&
      "transportCalls" in fields && fields.transportCalls === 1 &&
      "budget" in fields && JSON.stringify(fields.budget) === JSON.stringify({ used: 2000, cap: 2000, windowMinutes: 60 }))).toBe(true);
    expect(JSON.stringify([diagnostic.mock.calls, warning.mock.calls, error.mock.calls, partial.body])).not.toContain(canary);

    transport.mockClear();

    const stale = new Date(Date.now() - 31 * 60_000);
    await ctx.db.insert(connectionEventDeliveries).values([
      { companyId, provider: "github", providerDeliveryId: "stale-pr", event: "pull_request", status: "processed", createdAt: stale, normalizedPayload: { repository: "acme/app", number: 7, state: "open", headSha } },
      { companyId, provider: "github", providerDeliveryId: "stale-check", event: "check_run", status: "processed", createdAt: stale, normalizedPayload: { repository: "acme/app", number: 7, headSha, checkName: "CI result", status: "completed", conclusion: "success" } },
    ]);
    const staleResult = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: server/src/routes/issues.ts:42 is broken" });
    expect(staleResult.status, JSON.stringify(staleResult.body)).toBe(422);
    expect(transport).not.toHaveBeenCalled();

    await ctx.db.insert(connectionEventDeliveries).values([
      { companyId, provider: "github", providerDeliveryId: "moved-pr", event: "pull_request", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, state: "open", headSha: "b".repeat(40) } },
      { companyId, provider: "github", providerDeliveryId: "moved-check", event: "check_run", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, headSha: "b".repeat(40), checkName: "CI result", status: "completed", conclusion: "failure" } },
    ]);
    const movedResult = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI is unavailable" });
    expect(movedResult.status, JSON.stringify(movedResult.body)).toBe(422);
    expect(transport).not.toHaveBeenCalled();

    await ctx.db.delete(connectionEventDeliveries).where(sql`${connectionEventDeliveries.companyId} = ${companyId}`);
    await ctx.db.insert(connectionEventDeliveries).values([
      { companyId, provider: "github", providerDeliveryId: "pending-pr", event: "pull_request", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, state: "open", headSha } },
      { companyId, provider: "github", providerDeliveryId: "pending-check", event: "check_run", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, headSha, checkName: "CI result", status: "in_progress", conclusion: null } },
    ]);
    const pending = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI failed" });
    expect(pending.status, JSON.stringify(pending.body)).toBe(422);
    expect(transport).not.toHaveBeenCalled();
    const [stillInReview] = await ctx.db.select().from(issues).where(sql`${issues.id} = ${issueId}`);
    expect(stillInReview?.status).toBe("in_review");

    await ctx.db.delete(connectionEventDeliveries).where(sql`${connectionEventDeliveries.companyId} = ${companyId}`);
    await ctx.db.insert(connectionEventDeliveries).values([
      { companyId, provider: "github", providerDeliveryId: "synthetic-pr", event: "pull_request", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, state: "open", headSha } },
      { companyId, provider: "github", providerDeliveryId: "synthetic-check", event: "check_run", status: "processed", normalizedPayload: { repository: "acme/app", number: 7, headSha, checkName: "CI result", status: "completed", conclusion: "failure" } },
    ]);
    // Each admission must read the head and CI afresh, including locked sweeps.
    const workflowUrl = "https://api.github.com/repos/acme/app/contents/.github/workflows";
    const checkUrl = `https://api.github.com/repos/acme/app/commits/${headSha}/check-runs?check_name=CI%20result&filter=all&per_page=100`;
    const latestChecksUrl = `https://api.github.com/repos/acme/app/commits/${headSha}/check-runs?filter=latest&per_page=100`;
    await ctx.db.delete(toolGatewayRateLimitCounters).where(sql`${toolGatewayRateLimitCounters.companyId} = ${companyId}`);
    transport.mockImplementation(async (url) => {
      if (url === pullUrl) return Response.json({ state: "open", head: { sha: headSha } });
      if (url === workflowUrl) return Response.json([{ name: "ci.yml" }]);
      if (url === latestChecksUrl) return Response.json({ check_runs: [] });
      if (url === checkUrl) return Response.json({ check_runs: [{ name: "CI result", status: "completed", conclusion: "failure", head_sha: headSha }] });
      throw new Error("Unexpected external transport");
    });
    const accepted = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI is unavailable" });
    await drainHeartbeatRunsToQuiescence(ctx.db, heartbeatService(ctx.db));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.status).toBe("in_progress");
    expect(transport.mock.calls.slice(0, 3).map(([url]) => url)).toEqual([pullUrl, workflowUrl, checkUrl]);
    expect(unexpectedCalls(transport.mock.calls, [pullUrl, workflowUrl, checkUrl, latestChecksUrl])).toEqual([]);
    expect(JSON.stringify([diagnostic.mock.calls, warning.mock.calls, error.mock.calls, accepted.body])).not.toContain(canary);
    await ctx.db.update(issues).set({ status: "in_review", executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer, userId: null }, returnAssignee: { type: "agent", agentId: author, userId: null }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null } }).where(sql`${issues.id} = ${issueId}`);
    await ctx.db.delete(connectionEventDeliveries).where(sql`${connectionEventDeliveries.companyId} = ${companyId}`);
    transport.mockReset();
    diagnostic.mockClear();
    resetReviewCiCacheForTests();
    await ctx.db.delete(toolGatewayRateLimitCounters).where(sql`${toolGatewayRateLimitCounters.companyId} = ${companyId}`);
    transport.mockImplementation(async (url) => {
      if (url === pullUrl) return Response.json({ state: "open", head: { sha: headSha } });
      if (url === workflowUrl) return Response.json([{ name: "ci.yml" }]);
      if (url === latestChecksUrl) return Response.json({ check_runs: [] });
      if (url === checkUrl) return Response.json({ check_runs: [{ name: "CI result", status: "completed", conclusion: "success", head_sha: headSha }] });
      throw new Error("Unexpected external transport");
    });
    const success = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI passed" });
    await drainHeartbeatRunsToQuiescence(ctx.db, heartbeatService(ctx.db));
    expect(success.status, JSON.stringify(success.body)).toBe(200);
    // OPE-15114: every admission reads GitHub afresh; the sweep that follows
    // the PATCH may read again, so only the admission's own read order is pinned.
    expect(transport.mock.calls.slice(0, 3).map(([url]) => url)).toEqual([pullUrl, workflowUrl, checkUrl]);
    expect(unexpectedCalls(transport.mock.calls, [pullUrl, workflowUrl, checkUrl, latestChecksUrl])).toEqual([]);
    expect(diagnostic.mock.calls.some(([fields]) => typeof fields === "object" && fields !== null &&
      "transportCalls" in fields && fields.transportCalls === 3 &&
      "budget" in fields && JSON.stringify(fields.budget) === JSON.stringify({ used: 3, cap: 2000, windowMinutes: 60 }))).toBe(true);
    expect(JSON.stringify([diagnostic.mock.calls, warning.mock.calls, error.mock.calls, success.body])).not.toContain(canary);
  });
  it.each([false, true])("defers a triggered review monitor after a budget-exhausted write (sweep already rearmed: %s)", async (sweepAlreadyRearmed) => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Review budget retry");
    const author = randomUUID(), reviewer = randomUUID(), issueId = randomUUID(), runId = randomUUID(), stageId = randomUUID();
    const base = { companyId, status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} };
    await ctx.db.insert(agents).values([
      { ...base, id: author, name: "Author", role: "engineer" },
      { ...base, id: reviewer, name: "Reviewer", role: "reviewer" },
    ]);
    const lastTriggeredAt = new Date(Date.now() - 11 * 60_000);
    await ctx.db.insert(issues).values({
      id: issueId, companyId, title: "Exhausted review retry", status: "in_review", priority: "critical",
      createdByAgentId: author, assigneeAgentId: author,
      executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewer, userId: null }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer, userId: null }, returnAssignee: { type: "agent", agentId: author, userId: null }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: { status: "triggered", nextCheckAt: null, lastTriggeredAt: lastTriggeredAt.toISOString(), attemptCount: 1, notes: "Review CI wait", scheduledBy: "assignee", serviceName: "Review CI wait", externalRef: null, timeoutAt: null, maxAttempts: null, recoveryPolicy: null, clearedAt: null, clearReason: null } },
      monitorLastTriggeredAt: lastTriggeredAt, monitorAttemptCount: 1,
    });
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewer, status: "succeeded", contextSnapshot: { issueId } });
    await ctx.db.insert(issueWorkProducts).values({ companyId, issueId, type: "pull_request", provider: "github", title: "Synthetic PR", url: "https://github.com/acme/app/pull/7", status: "open", isPrimary: true, metadata: { repo: "acme/app", number: 7 } });
    const [clock] = await ctx.db.execute(sql`select floor(extract(epoch from clock_timestamp()) / 60)::bigint as minute`);
    const minute = Number(clock?.minute), start = new Date(minute * 60_000);
    const [carrier] = await ctx.db.select({ id: companies.id }).from(companies).orderBy(companies.createdAt).limit(1);
    await ctx.db.insert(toolGatewayRateLimitCounters).values({ companyId: carrier.id, counterKey: `github-budget:review-rework:${minute}`, windowStartAt: start, windowMs: 60_000, limit: 2000, count: 2000, resetAt: new Date(start.getTime() + 3_600_000) });
    const app = routeApp(ctx.db, { type: "agent", agentId: reviewer, companyId, source: "agent_key", runId } as never, issueRoutes);
    if (sweepAlreadyRearmed) {
      await heartbeatService(ctx.db).tickTimers(new Date());
      const [rearmed] = await ctx.db.select().from(issues).where(sql`${issues.id} = ${issueId}`);
      expect(rearmed.monitorNextCheckAt).not.toBeNull();
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const rejected = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: preserve this finding" });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    }
    expect(transport).not.toHaveBeenCalled();
    const [after] = await ctx.db.select().from(issues).where(sql`${issues.id} = ${issueId}`);
    expect(after.status).toBe("in_review");
    expect(after.assigneeAgentId).toBe(author);
    expect(after.monitorNextCheckAt?.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    const scheduledAt = after.monitorNextCheckAt?.getTime();
    const heartbeat = heartbeatService(ctx.db);
    for (const minutes of [11, 20, 30, 50]) {
      await heartbeat.tickTimers(new Date(Date.now() + minutes * 60_000));
    }
    const [afterTicks] = await ctx.db.select().from(issues).where(sql`${issues.id} = ${issueId}`);
    expect(afterTicks.monitorNextCheckAt?.getTime()).toBe(scheduledAt);
    expect(afterTicks.monitorAttemptCount).toBe(1);
    expect(afterTicks.status).toBe("in_review");
    expect(transport).not.toHaveBeenCalled();

    // Simulate the existing bucket aging out, without resetting the budget.
    const expiredMinute = minute - 61;
    const expiredStart = new Date(expiredMinute * 60_000);
    await ctx.db.update(toolGatewayRateLimitCounters).set({
      counterKey: `github-budget:review-rework:${expiredMinute}`,
      windowStartAt: expiredStart,
      resetAt: new Date(expiredStart.getTime() + 3_600_000),
    }).where(sql`${toolGatewayRateLimitCounters.companyId} = ${carrier.id}`);
    const headSha = "e".repeat(40);
    const workflowUrl = "https://api.github.com/repos/acme/app/contents/.github/workflows";
    const checkUrl = `https://api.github.com/repos/acme/app/commits/${headSha}/check-runs?check_name=CI%20result&filter=all&per_page=100`;
    transport.mockImplementation(async (url) => {
      if (url === pullUrl) return Response.json({ state: "open", head: { sha: headSha } });
      if (url === workflowUrl) return Response.json([{ name: "ci.yml" }]);
      if (url === checkUrl) return Response.json({ check_runs: [{ name: "CI result", status: "completed", conclusion: "failure", head_sha: headSha }] });
      throw new Error("Unexpected external transport");
    });
    const accepted = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: preserve this finding" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const fetched = await request(app).get(`/api/issues/${issueId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.status).toBe("in_progress");
    expect(fetched.body.assigneeAgentId).toBe(author);
    const comments = await request(app).get(`/api/issues/${issueId}/comments`);
    expect(comments.status).toBe(200);
    expect(JSON.stringify(comments.body)).toContain("REQUEST CHANGES: preserve this finding");
  });

  it("rejects a verdict on stored wake evidence alone when the review budget is exhausted (OPE-15114)", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Shared wake evidence");
    const author = randomUUID(), reviewer = randomUUID(), issueId = randomUUID(), runId = randomUUID(), stageId = randomUUID();
    const headSha = "c".repeat(40);
    const base = { companyId, status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} };
    await ctx.db.insert(agents).values([
      { ...base, id: author, name: "Author", role: "engineer" },
      { ...base, id: reviewer, name: "Reviewer", role: "reviewer" },
    ]);
    await ctx.db.insert(issues).values({
      id: issueId, companyId, title: "Shared evidence gate", status: "in_review", priority: "medium",
      createdByAgentId: author, assigneeAgentId: author,
      executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewer, userId: null }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer, userId: null }, returnAssignee: { type: "agent", agentId: author, userId: null }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null },
    });
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewer, status: "succeeded", contextSnapshot: { issueId } });
    await ctx.db.insert(issueWorkProducts).values({ companyId, issueId, type: "pull_request", provider: "github", title: "Synthetic PR", url: "https://github.com/acme/app/pull/7", status: "open", isPrimary: true, metadata: { repo: "acme/app", number: 7, headSha } });
    const wakeFetch = vi.fn(async (url: string) => {
      if (url.includes("/pulls/7")) return Response.json({ state: "open", head: { sha: headSha, ref: "branch" } });
      if (url.includes("/check-runs")) return Response.json({ total_count: 1, check_runs: [{ id: 1, name: "CI result", status: "completed", conclusion: "failure", head_sha: headSha, html_url: "https://github.com/acme/app/actions/runs/1", started_at: new Date().toISOString(), completed_at: new Date().toISOString() }] });
      return new Response(null, { status: 404 });
    });
    const wake = createPullRequestCiResolver(ctx.db, { source: "run-context", fetch: wakeFetch, tokenProvider: async () => canary });
    const evidence = await wake.resolveForPullRequest(companyId, { host: "github.com", owner: "acme", repo: "app", number: 7 });
    expect(evidence).toMatchObject({ authoritative: true, status: "completed", headSha });
    const [clock] = await ctx.db.execute(sql`select floor(extract(epoch from clock_timestamp()) / 60)::bigint as minute`);
    const minute = Number(clock?.minute), start = new Date(minute * 60_000);
    // The installation-wide review budget is carried by the oldest company.
    const [budgetCompany] = await ctx.db.select({ id: companies.id }).from(companies).orderBy(companies.createdAt).limit(1);
    await ctx.db.insert(toolGatewayRateLimitCounters).values({ companyId: budgetCompany.id, counterKey: `github-budget:review-rework:${minute}`, windowStartAt: start, windowMs: 60_000, limit: 2000, count: 2000, resetAt: new Date(start.getTime() + 3_600_000) });
    const app = routeApp(ctx.db, { type: "agent", agentId: reviewer, companyId, source: "agent_key", runId } as never, issueRoutes);
    for (const otherHead of ["d".repeat(40), null]) {
      await ctx.db.update(issueWorkProducts).set({ metadata: { repo: "acme/app", number: 7, headSha: otherHead } }).where(sql`${issueWorkProducts.issueId} = ${issueId}`);
      const rejected = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI failed" });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    }
    await ctx.db.update(issueWorkProducts).set({ metadata: { repo: "acme/app", number: 7, headSha } }).where(sql`${issueWorkProducts.issueId} = ${issueId}`);
    // A check-run event invalidates the old verdict before a rerun can be admitted.
    invalidateCiCacheForHead(companyId, "acme/app", headSha);
    const invalidated = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI failed" });
    expect(invalidated.status, JSON.stringify(invalidated.body)).toBe(422);
    expect(transport).not.toHaveBeenCalled();
    await ctx.db.delete(toolGatewayRateLimitCounters).where(sql`${toolGatewayRateLimitCounters.companyId} = ${budgetCompany.id}`);
    transport.mockImplementation(async () => new Response(null, { status: 403 }));
    const forbidden = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI failed" });
    expect(forbidden.status, JSON.stringify(forbidden.body)).toBe(422);
    expect(transport).toHaveBeenCalled();
    transport.mockImplementation(async () => { throw new Error("connection reset"); });
    const disconnected = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI failed" });
    expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(422);
    expect(disconnected.body.error).toContain("CI status for the current pull request head is unavailable");
    transport.mockReset();
    await ctx.db.insert(toolGatewayRateLimitCounters).values({ companyId: budgetCompany.id, counterKey: `github-budget:review-rework:${minute}`, windowStartAt: start, windowMs: 60_000, limit: 2000, count: 2000, resetAt: new Date(start.getTime() + 3_600_000) });
    await wake.resolveForPullRequest(companyId, { host: "github.com", owner: "acme", repo: "app", number: 7 });
    // OPE-15114: stored wake evidence is not an admission-grade read. With the
    // budget exhausted the gate cannot confirm the current head, so it fails
    // closed instead of returning the task on a remembered verdict.
    const response = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress", comment: "REQUEST CHANGES: CI failed" });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(transport).not.toHaveBeenCalled();
  });
});
