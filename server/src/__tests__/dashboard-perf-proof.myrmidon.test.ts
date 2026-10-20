import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard perf tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dashboard performance proof (OPE-7606)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();

  async function insertInChunks<T extends Record<string, unknown>>(
    table: Parameters<typeof db.insert>[0],
    rows: T[],
    chunkSize = 400,
  ) {
    for (let i = 0; i < rows.length; i += chunkSize) {
      await db.insert(table).values(rows.slice(i, i + chunkSize) as any);
    }
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-perf-");
    db = createDb(tempDb.connectionString);

    const now = new Date();
    const monthStart = getUtcMonthStart(now);

    // 1. Company
    await db.insert(companies).values({
      id: companyId,
      name: "Acme Production Synthetic",
      issuePrefix: "ACME",
      budgetMonthlyCents: 500_000,
      requireBoardApprovalForNewAgents: false,
    });

    // 2. 650 Agents (600+ as observed in production)
    const agentIds: string[] = [];
    const agentRows: Array<typeof agents.$inferInsert> = [];
    const agentStatuses = ["idle", "active", "running", "paused", "error"] as const;
    for (let i = 0; i < 650; i++) {
      const id = randomUUID();
      agentIds.push(id);
      agentRows.push({
        id,
        companyId,
        name: `agent-${i}`,
        role: "engineer",
        status: agentStatuses[i % agentStatuses.length],
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await insertInChunks(agents, agentRows);

    // 3. 6,700 Issues (~6.7k issues as in production)
    const issueStatuses = ["in_progress", "blocked", "done", "open", "backlog"] as const;
    const issueRows: Array<typeof issues.$inferInsert> = [];
    for (let i = 0; i < 6700; i++) {
      issueRows.push({
        id: randomUUID(),
        companyId,
        title: `Task #${i}`,
        status: issueStatuses[i % issueStatuses.length],
        workMode: "standard",
        priority: "medium",
        assigneeAgentId: agentIds[i % agentIds.length],
      });
    }
    await insertInChunks(issues, issueRows);

    // 4. 500 Budget Policies
    const policyRows: Array<typeof budgetPolicies.$inferInsert> = [];
    for (let i = 0; i < 500; i++) {
      policyRows.push({
        id: randomUUID(),
        companyId,
        scopeType: "agent",
        scopeId: agentIds[i],
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 10_000,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      });
    }
    await insertInChunks(budgetPolicies, policyRows);

    // 5. 3,000 Cost Events in current month
    const costEventRows: Array<typeof costEvents.$inferInsert> = [];
    for (let i = 0; i < 3000; i++) {
      costEventRows.push({
        id: randomUUID(),
        companyId,
        agentId: agentIds[i % agentIds.length],
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        costCents: 25,
        occurredAt: new Date(monthStart.getTime() + (i % 20) * 3600 * 1000),
      });
    }
    await insertInChunks(costEvents, costEventRows);

    // 6. 10,000 Heartbeat Runs in past 14 days (with retries)
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];
    const priorRunIds: string[] = [];
    const runStatuses = ["succeeded", "failed", "timed_out", "running"] as const;
    const runErrors = ["process_lost", "provider_quota", "timed_out", "unknown"] as const;

    for (let i = 0; i < 10000; i++) {
      const id = randomUUID();
      const status = runStatuses[i % runStatuses.length];
      const errorCode = status === "failed" || status === "timed_out" ? runErrors[i % runErrors.length] : null;
      // 10% of runs retry a prior run
      const retryOfRunId = i > 100 && i % 10 === 0 ? priorRunIds[i % priorRunIds.length] : null;
      const dayOffset = -(i % 14);
      const createdAt = new Date(now.getTime() + dayOffset * 86400 * 1000);

      runRows.push({
        id,
        companyId,
        agentId: agentIds[i % agentIds.length],
        status,
        errorCode,
        retryOfRunId,
        createdAt,
      });
      priorRunIds.push(id);
    }
    await insertInChunks(heartbeatRuns, runRows);

    // EXPLAIN ANALYZE on optimized runActivity query
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400 * 1000);
    const explainRunActivity = await db.execute(sql`
      EXPLAIN (ANALYZE, BUFFERS)
      WITH RECURSIVE recovered_runs(id) AS (
        SELECT parent.id
        FROM ${heartbeatRuns} AS child
        JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
        WHERE child.company_id = ${companyId}
          AND child.status = 'succeeded'
          AND child.created_at >= ${fourteenDaysAgo.toISOString()}::timestamptz
        UNION
        SELECT parent.id
        FROM recovered_runs rr
        JOIN ${heartbeatRuns} AS child ON child.id = rr.id
        JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
        WHERE child.created_at >= ${fourteenDaysAgo.toISOString()}::timestamptz
      )
      SELECT
        to_char(run.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        run.status AS status,
        run.error_code AS error_code,
        (rr.id IS NOT NULL) AS recovered,
        count(*)::double precision AS count
      FROM ${heartbeatRuns} AS run
      LEFT JOIN recovered_runs rr ON rr.id = run.id
      WHERE run.company_id = ${companyId}
        AND run.created_at >= ${fourteenDaysAgo.toISOString()}::timestamptz
      GROUP BY date, run.status, run.error_code, (rr.id IS NOT NULL)
    `);
    console.log(
      "[dashboard-perf-proof] EXPLAIN ANALYZE (run activity):\n",
      (explainRunActivity as unknown as Array<{ "QUERY PLAN": string }>).map((r) => r["QUERY PLAN"]).join("\n"),
    );

    // EXPLAIN ANALYZE on batch cost query
    const explainCost = await db.execute(sql`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT
        agent_id,
        coalesce(sum(cost_cents), 0)::double precision AS total
      FROM ${costEvents}
      WHERE company_id = ${companyId}
        AND occurred_at >= ${monthStart.toISOString()}::timestamptz
        AND occurred_at < ${new Date(monthStart.getTime() + 30 * 86400 * 1000).toISOString()}::timestamptz
        AND agent_id IS NOT NULL
      GROUP BY agent_id
    `);
    console.log(
      "[dashboard-perf-proof] EXPLAIN ANALYZE (batch cost sum):\n",
      (explainCost as unknown as Array<{ "QUERY PLAN": string }>).map((r) => r["QUERY PLAN"]).join("\n"),
    );
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("serves dashboard.summary across 10 consecutive requests with p95 < 3s on synthetic production-scale dataset", async () => {
    const service = dashboardService(db);
    const timings: number[] = [];

    // Warm-up run
    const warmup = await service.summary(companyId);
    expect(warmup.companyId).toBe(companyId);

    // 10 measured runs
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const res = await service.summary(companyId);
      const elapsed = performance.now() - start;
      timings.push(elapsed);

      expect(res.companyId).toBe(companyId);
      expect(res.agents.active).toBeGreaterThan(0);
      expect(res.tasks.open).toBeGreaterThan(0);
      expect(res.costs.monthSpendCents).toBeGreaterThan(0);
      expect(res.runActivity.length).toBe(14);
    }

    const sorted = [...timings].sort((a, b) => a - b);
    // 95th percentile of 10 samples (index 9)
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];

    console.log(`[dashboard-perf-proof] 10 query timings (ms): ${timings.map((t) => t.toFixed(2)).join(", ")}`);
    console.log(`[dashboard-perf-proof] p95 latency: ${p95.toFixed(2)} ms (target < 3000 ms)`);

    expect(p95).toBeLessThan(3000);
  });
});
