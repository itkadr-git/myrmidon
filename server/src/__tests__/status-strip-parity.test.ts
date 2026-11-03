import { randomUUID } from \"node:crypto\";
import request from \"supertest\";
import { describe, expect, it } from \"vitest\";
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
} from \"@myrmidon/db\";
import { statusStripRoutes } from \"../routes/status-strip.js\";
import { dashboardRoutes } from \"../routes/dashboard.js\";
import { sidebarBadgeRoutes } from \"../routes/sidebar-badges.js\";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from \"./helpers/route-test-harness.js\";

describeEmbeddedPostgres(\"status-strip endpoint parity & acceptance\", () => {
  const ctx = useEmbeddedPostgres(\"status-strip-parity-\", {
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

  it(\"returns zeros and nulls for company without data (not 500)\", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, \"Empty Company\");
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

  it(\"matches dashboard summary and sidebar badges counts on a shared fixture\", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, \"Parity Company\");

    // Give company a budget
    await ctx.db
      .update(companies)
      .set({ budgetMonthlyCents: 500_000 })
      .where(companies.id.getSQL().append(` = '${companyId}'`));

    // Seed agents: 2 running, 3 idle, 1 paused, 1 error
    const createAgent = async (name: string, status: string) => {
      const id = randomUUID();
      await ctx.db.insert(agents).values({
        id,
        companyId,
        name,
        status,
        role: \"engineer\",
      });
      return id;
    };

    const agent1 = await createAgent(\"agent-run-1\", \"running\");
    const agent2 = await createAgent(\"agent-run-2\", \"running\");
    const agent3 = await createAgent(\"agent-idle-1\", \"idle\");
    await createAgent(\"agent-idle-2\", \"idle\");
    await createAgent(\"agent-idle-3\", \"idle\");
    await createAgent(\"agent-paused-1\", \"paused\");
    await createAgent(\"agent-error-1\", \"error\");

    // Seed runs:
    // 1 running, 1 queued, 1 retrying, 1 succeeded, 2 failed runs today
    const now = new Date();
    const createRun = async (agentId: string, status: string, createdAt = now) => {
      const id = randomUUID();
      await ctx.db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        status,
        invocationSource: \"on_demand\",
        createdAt,
      });
      return id;
    };

    await createRun(agent1, \"running\");
    await createRun(agent2, \"queued\");
    await createRun(agent3, \"retrying\");
    await createRun(agent1, \"succeeded\");
    const failedRun1 = await createRun(agent2, \"failed\", now);
    const failedRun2 = await createRun(agent3, \"timed_out\", now);

    // Seed cost events: 1 priced (1500 cents), 1 unpriced
    await ctx.db.insert(costEvents).values([
      {
        id: randomUUID(),
        companyId,
        agentId: agent1,
        provider: \"test\",
        biller: \"test\",
        billingType: \"api\",
        model: \"test-model\",
        costStatus: \"reported\",
        costCents: 1500,
        occurredAt: now,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: agent2,
        provider: \"test\",
        biller: \"test\",
        billingType: \"api\",
        model: \"test-model\",
        costStatus: \"unpriced\",
        costCents: 0,
        occurredAt: now,
      },
    ]);

    // Seed approvals: 1 pending, 1 revision_requested, 1 approved
    const createApproval = async (type: string, status: string) => {
      const id = randomUUID();
      await ctx.db.insert(approvals).values({
        id,
        companyId,
        type,
        status,
        payload: {},
        createdAt: now,
        updatedAt: now,
      });
      return id;
    };

    const approval1 = await createApproval(\"hire_agent\", \"pending\");
    await createApproval(\"budget_increase\", \"revision_requested\");
    await createApproval(\"tool_access\", \"approved\");

    // Seed decisions & interactions: need an issue
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: \"Test Issue\",
      status: \"in_progress\",
    });

    await ctx.db.insert(decisions).values([
      {
        id: randomUUID(),
        companyId,
        originAgentId: agent1,
        originIssueId: issueId,
        originRunId: failedRun1,
        title: \"Decision 1\",
        body: \"Body\",
        options: [{ id: \"opt1\", label: \"Option 1\" }],
        status: \"open\",
        expiresAt: new Date(Date.now() + 86400000),
        signedSpec: \"spec\",
        targetSnapshots: {},
      },
      {
        id: randomUUID(),
        companyId,
        originAgentId: agent1,
        originIssueId: issueId,
        originRunId: failedRun1,
        title: \"Decision 2\",
        body: \"Body\",
        options: [{ id: \"opt1\", label: \"Option 1\" }],
        status: \"resolved\",
        expiresAt: new Date(Date.now() + 86400000),
        signedSpec: \"spec\",
        targetSnapshots: {},
      },
    ]);

    await ctx.db.insert(issueThreadInteractions).values([
      {
        id: randomUUID(),
        companyId,
        issueId,
        kind: \"ask_user_questions\",
        status: \"pending\",
      },
      {
        id: randomUUID(),
        companyId,
        issueId,
        kind: \"ask_user_questions\",
        status: \"resolved\",
      },
    ]);

    // Seed inbox dismissals: dismiss 1 approval and 1 failed run
    await ctx.db.insert(inboxDismissals).values([
      {
        id: randomUUID(),
        companyId,
        userId,
        itemKey: `approval:${approval1}`,
        kind: \"dismiss\",
        dismissedAt: new Date(Date.now() + 1000),
      },
      {
        id: randomUUID(),
        companyId,
        userId,
        itemKey: `run:${failedRun1}`,
        kind: \"dismiss\",
        dismissedAt: new Date(Date.now() + 1000),
      },
    ]);

    // Setup app with status-strip, dashboard, and sidebar-badges routes
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

    // 1. Colony parity
    expect(strip.colony.running).toBe(2);
    expect(strip.colony.idle).toBe(3);
    expect(strip.colony.paused).toBe(1);
    expect(strip.colony.error).toBe(1);
    // Dashboard groups running + idle into 'active'
    expect(strip.colony.running + strip.colony.idle).toBe(dashboard.agentCounts.active);
    expect(strip.colony.paused).toBe(dashboard.agentCounts.paused);
    expect(strip.colony.error).toBe(dashboard.agentCounts.error);

    // 2. Runs
    expect(strip.runs.running).toBe(1);
    // Queued status includes queued and retrying
    expect(strip.runs.queued).toBe(2);
    // FailedToday matches 1 (2 failed runs today minus 1 dismissed)
    expect(strip.runs.failedToday).toBe(1);
    // On sidebar badges, latest run per agent: agent2 (failedRun1, dismissed), agent3 (failedRun2, visible) -> 1
    expect(strip.runs.failedToday).toBe(sidebar.failedRuns);

    // 3. Costs parity
    expect(strip.costs.monthSpendCents).toBe(1500);
    expect(strip.costs.monthSpendCents).toBe(dashboard.monthSpendCents);
    expect(strip.costs.budgetCents).toBe(500_000);
    expect(strip.costs.budgetCents).toBe(dashboard.budgetMonthlyCents);
    expect(strip.costs.unpricedEvents).toBe(1);

    // 4. Waiting / Badges parity
    // Approvals: 2 actionable (pending, revision_requested) minus 1 dismissed = 1
    expect(strip.waiting.approvals).toBe(1);
    expect(strip.waiting.approvals).toBe(sidebar.approvals);
    expect(strip.waiting.decisions).toBe(1);
    expect(strip.waiting.interactions).toBe(1);
  });
});
