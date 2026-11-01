import { and, desc, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@myrmidon/db";
import { activityLog, agents, companies, costEvents, heartbeatRuns, issues, projects } from "@myrmidon/db";
import type { CostByDay } from "@myrmidon/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { agentPromptStats, type AgentPromptStats } from "../myrmidon/prompt-budget/fleet-prompt-report.js"; // myrmidon(1.6.3 PROMPT-BUDGET D)
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import { visibleIssueCondition } from "./issue-visibility.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;

function sumAsNumber(column: typeof costEvents.costCents | typeof costEvents.inputTokens | typeof costEvents.cachedInputTokens | typeof costEvents.outputTokens) {
  return sql<number>`coalesce(sum(${column}), 0)::double precision`;
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

async function getMonthlySpendTotal(
  db: Db,
  scope: { companyId: string; agentId?: string | null },
  now = new Date(),
) {
  const { start, end } = currentUtcMonthWindow(now);
  const conditions = [
    eq(costEvents.companyId, scope.companyId),
    gte(costEvents.occurredAt, start),
    lt(costEvents.occurredAt, end),
  ];
  if (scope.agentId) {
    conditions.push(eq(costEvents.agentId, scope.agentId));
  }
  const [row] = await db
    .select({
      total: sumAsNumber(costEvents.costCents),
    })
    .from(costEvents)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

export function costService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const budgets = budgetService(db, budgetHooks);
  return {
    createEvent: async (companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId">) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) throw notFound("Agent not found");
      if (agent.companyId !== companyId) {
        throw unprocessable("Agent does not belong to company");
      }

      const event = await db
        .insert(costEvents)
        .values({
          ...data,
          companyId,
          biller: data.biller ?? data.provider,
          billingType: data.billingType ?? "unknown",
          cachedInputTokens: data.cachedInputTokens ?? 0,
        })
        .returning()
        .then((rows) => rows[0]);

      const [agentMonthSpend, companyMonthSpend] = await Promise.all([
        getMonthlySpendTotal(db, { companyId, agentId: event.agentId }),
        getMonthlySpendTotal(db, { companyId }),
      ]);

      await db
        .update(agents)
        .set({
          spentMonthlyCents: agentMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, event.agentId));

      await db
        .update(companies)
        .set({
          spentMonthlyCents: companyMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));

      await budgets.evaluateCostEvent(event);

      return event;
    },

    // myrmidon(1.7 UI-2.0 COSTS-SUMMARY): add unpricedEvents, unpricedTokens, and forecastCents
    summary: async (companyId: string, range?: CostDateRange, now = new Date()) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [{ total, unpricedEvents, unpricedTokens }] = await db
        .select({
          total: sumAsNumber(costEvents.costCents),
          unpricedEvents: sql<number>`coalesce(sum(case when ${costEvents.costStatus} = 'unpriced' then 1 else 0 end), 0)::integer`,
          unpricedTokens: sql<number>`coalesce(sum(case when ${costEvents.costStatus} = 'unpriced' then coalesce(${costEvents.inputTokens}, 0) + coalesce(${costEvents.cachedInputTokens}, 0) + coalesce(${costEvents.outputTokens}, 0) else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(...conditions));

      const spendCents = Number(total);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;

      let forecastCents: number | null = null;
      const passedDays = now.getUTCDate();
      if (passedDays >= 2) {
        const currentMonthSpend = await getMonthlySpendTotal(db, { companyId }, now);
        if (currentMonthSpend > 0) {
          const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
          forecastCents = Math.round((currentMonthSpend / passedDays) * daysInMonth);
        }
      }

      return {
        companyId,
        spendCents,
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
        unpricedEvents: Number(unpricedEvents ?? 0),
        unpricedTokens: Number(unpricedTokens ?? 0),
        forecastCents,
      };
    },

    issueTreeSummary: async (
      companyId: string,
      issueId: string,
      options: { excludeRoot?: boolean } = {},
    ) => {
      // Callers must resolve and authorize a visible root issue before invoking this.
      // The route does that so zero counts are not mistaken for a missing root.
      const childIssues = alias(issues, "child");

      // The seed of the recursive CTE: when excludeRoot is true, start from
      // the direct children so the root issue itself is not counted.
      const cteSeed = options.excludeRoot
        ? sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const cteSeedText = options.excludeRoot
        ? sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const issueTreeCondition = sql<boolean>`
        ${issues.id} IN (
          WITH RECURSIVE issue_tree(id) AS (
            ${cteSeed}
            UNION ALL
            SELECT ${childIssues.id}
            FROM ${issues} ${childIssues}
            JOIN issue_tree ON ${childIssues.parentId} = issue_tree.id
            WHERE ${childIssues.companyId} = ${companyId}
              AND ${childIssues.hiddenAt} IS NULL
              AND ${childIssues.harnessKind} IS NULL
          )
          SELECT id FROM issue_tree
        )
      `;

      const runSummarySql = sql`
        WITH RECURSIVE issue_tree(id) AS (
          ${cteSeedText}
          UNION ALL
          SELECT (${childIssues.id})::text
          FROM ${issues} ${childIssues}
          JOIN issue_tree ON (${childIssues.parentId})::text = issue_tree.id
          WHERE ${childIssues.companyId} = ${companyId}
            AND ${childIssues.hiddenAt} IS NULL
            AND ${childIssues.harnessKind} IS NULL
        )
        SELECT
          count(distinct ${heartbeatRuns.id})::int AS "runCount",
          coalesce(sum(extract(epoch from (coalesce(${heartbeatRuns.finishedAt}, now()) - ${heartbeatRuns.startedAt})) * 1000), 0)::double precision AS "runtimeMs"
        FROM ${heartbeatRuns}
        WHERE ${heartbeatRuns.companyId} = ${companyId}
          AND ${heartbeatRuns.startedAt} IS NOT NULL
          AND (
            ${heartbeatRuns.contextSnapshot} ->> 'issueId' IN (SELECT id FROM issue_tree)
            OR EXISTS (
              SELECT 1
              FROM ${activityLog}
              JOIN issue_tree ON ${activityLog.entityId} = issue_tree.id
              WHERE ${activityLog.companyId} = ${companyId}
                AND ${activityLog.entityType} = 'issue'
                AND ${activityLog.runId} = ${heartbeatRuns.id}
            )
          )
      `;

      // Run cost-event aggregation and run-duration aggregation in parallel.
      // They're separate queries because cost_events fan out per-event and
      // joining heartbeat_runs through them would double-count run durations.
      const [costRowResult, runRowResult] = await Promise.all([
        db
          .select({
            issueCount: sql<number>`count(distinct ${issues.id})::int`,
            costCents: sumAsNumber(costEvents.costCents),
            inputTokens: sumAsNumber(costEvents.inputTokens),
            cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
            outputTokens: sumAsNumber(costEvents.outputTokens),
          })
          .from(issues)
          .leftJoin(
            costEvents,
            and(
              eq(costEvents.companyId, companyId),
              eq(costEvents.issueId, issues.id),
            ),
          )
          .where(
            and(
              eq(issues.companyId, companyId),
              visibleIssueCondition(),
              issueTreeCondition,
            ),
          ),
        db.execute(runSummarySql),
      ]);

      const costRow = costRowResult[0];
      const runRow = Array.isArray(runRowResult)
        ? (runRowResult[0] as { runCount?: number | string | null; runtimeMs?: number | string | null } | undefined)
        : undefined;

      return {
        issueId,
        issueCount: Number(costRow?.issueCount ?? 0),
        includeDescendants: true,
        costCents: Number(costRow?.costCents ?? 0),
        inputTokens: Number(costRow?.inputTokens ?? 0),
        cachedInputTokens: Number(costRow?.cachedInputTokens ?? 0),
        outputTokens: Number(costRow?.outputTokens ?? 0),
        runCount: Number(runRow?.runCount ?? 0),
        runtimeMs: Number(runRow?.runtimeMs ?? 0),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const rows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.status)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));

      // myrmidon(1.6.3 PROMPT-BUDGET D): the fleet prompt report is additive on
      // this endpoint — two extra columns per agent (the average prompt size of
      // one run and the share of runs above the configured budget threshold).
      // The spend columns above are untouched: the prompt side comes from its
      // own per-run aggregate and is merged by agent id, so no join can fan out
      // and inflate the existing sums.
      const promptStats: Map<string, AgentPromptStats> =
        rows.length > 0 ? await agentPromptStats(db, companyId, range) : new Map();
      return rows.map((row) => ({
        ...row,
        avgPromptTokens: promptStats.get(row.agentId)?.avgPromptTokens ?? null,
        runsAboveThresholdPct: promptStats.get(row.agentId)?.runsAboveThresholdPct ?? null,
      }));
    },

    byProvider: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byBiller: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          biller: costEvents.biller,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
          providerCount: sql<number>`count(distinct ${costEvents.provider})::int`,
          modelCount: sql<number>`count(distinct ${costEvents.model})::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.biller)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    /**
     * aggregates cost_events by provider for each of three rolling windows:
     * last 5 hours, last 24 hours, last 7 days.
     * purely internal consumption data, no external rate-limit sources.
     */
    windowSpend: async (companyId: string) => {
      const windows = [
        { label: "5h", hours: 5 },
        { label: "24h", hours: 24 },
        { label: "7d", hours: 168 },
      ] as const;

      const results = await Promise.all(
        windows.map(async ({ label, hours }) => {
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          const rows = await db
            .select({
              provider: costEvents.provider,
              biller: sql<string>`case when count(distinct ${costEvents.biller}) = 1 then min(${costEvents.biller}) else 'mixed' end`,
              costCents: sumAsNumber(costEvents.costCents),
              inputTokens: sumAsNumber(costEvents.inputTokens),
              cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
              outputTokens: sumAsNumber(costEvents.outputTokens),
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, since),
              ),
            )
            .groupBy(costEvents.provider)
            .orderBy(desc(sumAsNumber(costEvents.costCents)));

          return rows.map((row) => ({
            provider: row.provider,
            biller: row.biller,
            window: label as string,
            windowHours: hours,
            costCents: row.costCents,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens,
          }));
        }),
      );

      return results.flat();
    },

    byAgentModel: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      // single query: group by agent + provider + model.
      // the (companyId, agentId, occurredAt) composite index covers this well.
      // order by provider + model for stable db-level ordering; cost-desc sort
      // within each agent's sub-rows is done client-side in the ui memo.
      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(
          costEvents.agentId,
          agents.name,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        )
        .orderBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model);
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId, issues.projectId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(issues.companyId, companyId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
          ),
        )
        .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
        .as("run_project_links");

      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runProjectLinks.projectId})`;
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sumAsNumber(costEvents.costCents);

      return db
        .select({
          projectId: effectiveProjectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(runProjectLinks, eq(costEvents.heartbeatRunId, runProjectLinks.runId))
        .innerJoin(projects, sql`${projects.id} = ${effectiveProjectId}`)
        .where(and(...conditions, sql`${effectiveProjectId} is not null`))
        .groupBy(effectiveProjectId, projects.name)
        .orderBy(desc(costCentsExpr));
    },

    byDay: async (companyId: string, range?: CostDateRange): Promise<CostByDay[]> => {
      let from = range?.from;
      let to = range?.to;

      if (!from && !to) {
        const now = new Date();
        const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        from = new Date(todayUtcMs - 29 * 24 * 60 * 60 * 1000);
        to = new Date(todayUtcMs + 24 * 60 * 60 * 1000 - 1);
      } else if (from && !to) {
        const now = new Date();
        to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
      } else if (!from && to) {
        const toUtcMs = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
        from = new Date(toUtcMs - 29 * 24 * 60 * 60 * 1000);
      }

      if (from!.getTime() > to!.getTime()) {
        throw badRequest("'from' date cannot be after 'to' date");
      }

      const diffMs = to!.getTime() - from!.getTime();
      if (diffMs > 93 * 24 * 60 * 60 * 1000) {
        throw badRequest("date range exceeds maximum of 93 days");
      }

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      conditions.push(gte(costEvents.occurredAt, from!));
      conditions.push(lte(costEvents.occurredAt, to!));

      const dayExpr = sql<string>`to_char(${costEvents.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;

      const rows = await db
        .select({
          day: dayExpr,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          unpricedEvents: sql<number>`coalesce(sum(case when ${costEvents.costStatus} = 'unpriced' then 1 else 0 end), 0)::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(dayExpr)
        .orderBy(dayExpr);

      const dayMap = new Map<string, typeof rows[number]>();
      for (const row of rows) {
        dayMap.set(row.day, row);
      }

      const fromDayStr = from!.toISOString().slice(0, 10);
      const toDayStr = to!.toISOString().slice(0, 10);

      const [startYear, startMonth, startDayNum] = fromDayStr.split("-").map(Number);
      const [endYear, endMonth, endDayNum] = toDayStr.split("-").map(Number);

      const cur = new Date(Date.UTC(startYear, startMonth - 1, startDayNum));
      const end = new Date(Date.UTC(endYear, endMonth - 1, endDayNum));

      const result: CostByDay[] = [];
      while (cur.getTime() <= end.getTime()) {
        const day = cur.toISOString().slice(0, 10);
        const row = dayMap.get(day);
        result.push({
          day,
          costCents: row ? Math.round(Number(row.costCents)) : 0,
          inputTokens: row ? Math.round(Number(row.inputTokens)) : 0,
          cachedInputTokens: row ? Math.round(Number(row.cachedInputTokens)) : 0,
          outputTokens: row ? Math.round(Number(row.outputTokens)) : 0,
          unpricedEvents: row ? Math.round(Number(row.unpricedEvents)) : 0,
        });
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      return result;
    },
  };
}
