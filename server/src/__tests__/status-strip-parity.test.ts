import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  companyMemberships,
  costEvents,
  decisions,
  heartbeatRuns,
  inboxDismissals,
  issues,
  issueThreadInteractions,
  principalPermissionGrants,
} from "@myrmidon/db";
import { statusStripRoutes } from "../routes/status-strip.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("status-strip endpoint parity & acceptance", () => {
  const ctx = useEmbeddedPostgres("status-strip-parity-", {
    resetEach: async (db) => {
      await db.delete(inboxDismissals);
      await db.delete(issueThreadInteractions);
      await db.delete(decisions);
      await db.delete(approvals);
      await db.delete(costEvents);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(principalPermissionGrants);
      await db.delete(companyMemberships);
      await db.delete(companies);
    },
  });

  it("returns zeros and nulls for company without data (not 500)", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Empty Company");
    const app = routeApp(ctx.db, actor, statusStripRoutes);

    const res = await request(app).get(`/api/companies/${companyId}/status-strip`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      colony: { running: 0, idle: 0, paused: 0, error: 0 },
      runs: { running: 0, queued: 0, failedToday: 0 },
      costs: { monthSpendCents: 0, budgetCents: 0, unpricedEvents: 0, forecastCents: null },
      waiting: { approvals: 0, decisions: 0, interactions: 0 },
    });
  });

  it("matches dashboard summary and sidebar badges counts on a shared fixture", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Parity Company");

    await ctx.db
      .update(companies)
      .set({ budgetMonthlyCents: 500_000 })
      .where(eq(companies.id, companyId));

    const createAgent = async (name: string, status: string) => {
      const id = randomUUID();
      await ctx.db.insert(agents).values({ id, companyId, name, status, role: "engineer" });
      return id;
    };

    const agent1 = await createAgent("agent-run-1", "running");
    const agent2 = await createAgent("agent-run-2", "running");
    const agent3 = await createAgent("agent-idle-1", "idle");
    await createAgent("agent-idle-2", "idle");
    await createAgent("agent-idle-3", "idle");
    await createAgent("agent-paused-1", "paused");
    await createAgent("agent-error-1", "error");

    const baseTime = Date.now();
    // Prior-month event to verify month-window filtering (past month must be excluded from monthSpendCents)
    const priorMonthDate = new Date(baseTime);
    priorMonthDate.setUTCMonth(priorMonthDate.getUTCMonth() - 1);
    priorMonthDate.setUTCDate(15);

    const createRun = async (agentId: string, status: string, offsetMs = 0) => {
      const id = randomUUID();
      const createdAt = new Date(baseTime + offsetMs);
      await ctx.db.insert(heartbeatRuns).values({ id, companyId, agentId, status, invocationSource: "on_demand", createdAt });
      return id;
    };

    // agent1: early failed run, a running run, and a latest succeeded run
    await createRun(agent1, "failed", 500);
    await createRun(agent1, "running", 1000);
    await createRun(agent1, "succeeded", 4000);

    // agent2: queued run and a latest failed run (dismissed)
    await createRun(agent2, "queued", 2000);
    const failedRun1 = await createRun(agent2, "failed", 5000);

    // agent3: retrying run and a latest timed_out run (active failed run)
    await createRun(agent3, "retrying", 3000);
    const failedRun2 = await createRun(agent3, "timed_out", 6000);

    await ctx.db.insert(costEvents).values([
      { id: randomUUID(), companyId, agentId: agent1, provider: "test", biller: "test", billingType: "api", model: "test-model", costStatus: "reported", costCents: 1500, occurredAt: new Date(baseTime) },
      { id: randomUUID(), companyId, agentId: agent2, provider: "test", biller: "test", billingType: "api", model: "test-model", costStatus: "unpriced", costCents: 0, occurredAt: new Date(baseTime) },
      // Prior-month event: must be ignored by both dashboard and status-strip
      { id: randomUUID(), companyId, agentId: agent1, provider: "test", biller: "test", billingType: "api", model: "test-model", costStatus: "reported", costCents: 9999, occurredAt: priorMonthDate },
    ]);

    const createApproval = async (type: string, status: string) => {
      const id = randomUUID();
      await ctx.db.insert(approvals).values({ id, companyId, type, status, payload: {}, createdAt: new Date(baseTime), updatedAt: new Date(baseTime) });
      return id;
    };

    const approval1 = await createApproval("hire_agent", "pending");
    await createApproval("budget_increase", "revision_requested");
    await createApproval("tool_access", "approved");

    const issueId = randomUUID();
    await ctx.db.insert(issues).values({ id: issueId, companyId, title: "Test Issue", status: "in_progress" });

    await ctx.db.insert(decisions).values([
      { id: randomUUID(), companyId, originAgentId: agent1, originIssueId: issueId, originRunId: failedRun1, title: "Decision 1", body: "Body", options: [{ id: "opt1", label: "Option 1" }], status: "open", expiresAt: new Date(baseTime + 86400000), signedSpec: "spec", targetSnapshots: {} },
      { id: randomUUID(), companyId, originAgentId: agent1, originIssueId: issueId, originRunId: failedRun1, title: "Decision 2", body: "Body", options: [{ id: "opt1", label: "Option 1" }], status: "resolved", expiresAt: new Date(baseTime + 86400000), signedSpec: "spec", targetSnapshots: {} },
    ]);

    await ctx.db.insert(issueThreadInteractions).values([
      { id: randomUUID(), companyId, issueId, kind: "ask_user_questions", status: "pending", payload: {} },
      { id: randomUUID(), companyId, issueId, kind: "ask_user_questions", status: "resolved", payload: {} },
    ]);

    await ctx.db.insert(inboxDismissals).values([
      { id: randomUUID(), companyId, userId, itemKey: `approval:${approval1}`, kind: "dismiss", dismissedAt: new Date(baseTime + 10000) },
      { id: randomUUID(), companyId, userId, itemKey: `run:${failedRun1}`, kind: "dismiss", dismissedAt: new Date(baseTime + 10000) },
    ]);

    const app = routeApp(ctx.db, actor, statusStripRoutes, dashboardRoutes, sidebarBadgeRoutes);
    const [statusStripRes, dashboardRes, sidebarBadgesRes] = await Promise.all([
      request(app).get(`/api/companies/${companyId}/status-strip`),
      request(app).get(`/api/companies/${companyId}/dashboard`),
      request(app).get(`/api/companies/${companyId}/sidebar-badges`),
    ]);

    expect(statusStripRes.status).toBe(200);
    expect(dashboardRes.status).toBe(200);
    expect(sidebarBadgesRes.status).toBe(200);

    const strip = statusStripRes.body;
    const dashboard = dashboardRes.body;
    const sidebar = sidebarBadgesRes.body;

    expect(strip.colony.running).toBe(2);
    expect(strip.colony.idle).toBe(3);
    expect(strip.colony.paused).toBe(1);
    expect(strip.colony.error).toBe(1);
    expect(strip.colony.running).toBe(dashboard.agents.running);
    expect(strip.colony.idle).toBe(dashboard.agents.active);
    expect(strip.colony.paused).toBe(dashboard.agents.paused);
    expect(strip.colony.error).toBe(dashboard.agents.error);

    expect(strip.runs.running).toBe(1);
    expect(strip.runs.queued).toBe(2);
    expect(strip.runs.failedToday).toBe(1);
    expect(strip.runs.failedToday).toBe(sidebar.failedRuns);

    expect(strip.costs.monthSpendCents).toBe(1500);
    expect(strip.costs.monthSpendCents).toBe(dashboard.costs.monthSpendCents);
    expect(strip.costs.budgetCents).toBe(500_000);
    expect(strip.costs.budgetCents).toBe(dashboard.costs.monthBudgetCents);
    expect(strip.costs.unpricedEvents).toBe(1);

    expect(strip.waiting.approvals).toBe(1);
    expect(strip.waiting.approvals).toBe(sidebar.approvals);
    expect(strip.waiting.decisions).toBe(1);
    expect(strip.waiting.interactions).toBe(1);
  });
});
