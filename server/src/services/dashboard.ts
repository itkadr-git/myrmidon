import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { executionIssueCondition } from "./issue-visibility.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);

      const [
        company,
        agentRows,
        taskRows,
        pendingApprovals,
        monthSpendResult,
        runActivityRows,
        budgetOverview,
      ] = await Promise.all([
        db
          .select()
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0] ?? null),
        db
          .select({ status: agents.status, count: sql<number>`count(*)` })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .groupBy(agents.status),
        db
          .select({ status: issues.status, count: sql<number>`count(*)` })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), executionIssueCondition()))
          .groupBy(issues.status),
        db
          .select({ count: sql<number>`count(*)` })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
          .then((rows) => Number(rows[0]?.count ?? 0)),
        db
          .select({
            monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
          })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.companyId, companyId),
              gte(costEvents.occurredAt, monthStart),
            ),
          ),
        db.execute(sql`
          WITH RECURSIVE recovered_runs(id) AS (
            SELECT parent.id
            FROM ${heartbeatRuns} AS child
            JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
            WHERE child.company_id = ${companyId}
              AND child.status = 'succeeded'
              AND child.created_at >= ${runActivityStart.toISOString()}::timestamptz
            UNION
            SELECT parent.id
            FROM recovered_runs rr
            JOIN ${heartbeatRuns} AS child ON child.id = rr.id
            JOIN ${heartbeatRuns} AS parent ON parent.id = child.retry_of_run_id
            WHERE child.created_at >= ${runActivityStart.toISOString()}::timestamptz
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
            AND run.created_at >= ${runActivityStart.toISOString()}::timestamptz
          GROUP BY date, run.status, run.error_code, (rr.id IS NOT NULL)
        `) as unknown as Promise<Iterable<{
          date: string;
          status: string;
          error_code: string | null;
          recovered: boolean | string;
          count: number | string;
        }>>,
        budgets.overview(companyId),
      ]);

      if (!company) throw notFound("Company not found");

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const monthSpendCents = Number(monthSpendResult[0]?.monthSpend ?? 0);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },
  };
}
