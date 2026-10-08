// server/src/myrmidon/budget-limits/usage.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): "spent in period" per hierarchy level,
// computed from the existing spend accounting — the litellm_cost_events
// ledger the M2-A sweep collects (issueId/agentId/occurredAt/costCents) plus
// the issues/agents/projects rows needed to attribute them to a level.
//
// Attribution rules (one level = one aggregation of the same ledger):
//  - nest   → all events of the company (ref "company"), or of the issues of
//             one project (ref = project uuid);
//  - caste  → events of the agents whose role is the ref;
//  - issue  → events whose issueId is the ref;
//  - foraging → the foraging pass's own spend view (foraging_budgetState),
//             ref "foraging" — OPE-3964 is absorbed by this level.
// Events without issueId do not count for nest-by-project, issue or (kept)
// caste levels; they always count for the company nest.

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { agents, issues, litellmCostEvents, type Db } from "@paperclipai/db";
import {
  budgetLimitWindow,
  BUDGET_LIMIT_FORAGING_REF,
  BUDGET_LIMIT_NEST_COMPANY_REF,
  type BudgetLimitLevel,
  type BudgetLimitPeriod,
} from "@paperclipai/shared";

/** A spend view one level: the summed cents and the event count behind them. */
export interface BudgetLimitUsage {
  level: BudgetLimitLevel;
  ref: string;
  period: BudgetLimitPeriod;
  spentCents: number;
  events: number;
}

export interface BudgetLimitUsageDeps {
  db: Db;
  /** The foraging budget view (per OPE-3964, absorbed by this level). */
  foragingBudgetState?: (companyId: string) => Promise<{ spentCents: number }>;
  now?: () => Date;
}

/** Sum the litellm ledger for one level+ref over one period. */
export async function computeBudgetLimitUsage(
  deps: BudgetLimitUsageDeps,
  companyId: string,
  level: BudgetLimitLevel,
  ref: string,
  period: BudgetLimitPeriod,
): Promise<BudgetLimitUsage> {
  const window = budgetLimitWindow(period, (deps.now ?? (() => new Date()))());
  const conditions = [eq(litellmCostEvents.companyId, companyId)];
  if (window.start) conditions.push(gte(litellmCostEvents.occurredAt, window.start));
  if (window.end) conditions.push(lt(litellmCostEvents.occurredAt, window.end));

  if (level === "nest" && ref === BUDGET_LIMIT_NEST_COMPANY_REF) {
    const row = await deps.db
      .select({
        cents: sql<number>`coalesce(sum(${litellmCostEvents.costCents}), 0)::int`,
        events: sql<number>`count(*)::int`,
      })
      .from(litellmCostEvents)
      .where(and(...conditions));
    const first = row[0];
    return { level, ref, period, spentCents: first?.cents ?? 0, events: first?.events ?? 0 };
  }

  if (level === "nest") {
    // ref = project uuid: sum the events whose issue belongs to the project.
    const row = await deps.db
      .select({
        cents: sql<number>`coalesce(sum(${litellmCostEvents.costCents}), 0)::int`,
        events: sql<number>`count(*)::int`,
      })
      .from(litellmCostEvents)
      .innerJoin(issues, sql`${issues.id}::text = ${litellmCostEvents.issueId}`)
      .where(and(...conditions, eq(issues.projectId, ref)));
    const first = row[0];
    return { level, ref, period, spentCents: first?.cents ?? 0, events: first?.events ?? 0 };
  }

  if (level === "caste") {
    // ref = role key: sum the events of the agents whose role is the ref.
    const row = await deps.db
      .select({
        cents: sql<number>`coalesce(sum(${litellmCostEvents.costCents}), 0)::int`,
        events: sql<number>`count(*)::int`,
      })
      .from(litellmCostEvents)
      .innerJoin(agents, sql`${agents.id}::text = ${litellmCostEvents.agentId}`)
      .where(and(...conditions, eq(agents.role, ref)));
    const first = row[0];
    return { level, ref, period, spentCents: first?.cents ?? 0, events: first?.events ?? 0 };
  }

  if (level === "issue") {
    const row = await deps.db
      .select({
        cents: sql<number>`coalesce(sum(${litellmCostEvents.costCents}), 0)::int`,
        events: sql<number>`count(*)::int`,
      })
      .from(litellmCostEvents)
      .where(and(...conditions, eq(litellmCostEvents.issueId, ref)));
    const first = row[0];
    return { level, ref, period, spentCents: first?.cents ?? 0, events: first?.events ?? 0 };
  }

  if (level === "foraging" && ref === BUDGET_LIMIT_FORAGING_REF) {
    const state = deps.foragingBudgetState
      ? await deps.foragingBudgetState(companyId)
      : { spentCents: 0 };
    return { level, ref, period, spentCents: state.spentCents, events: 0 };
  }

  return { level, ref, period, spentCents: 0, events: 0 };
}

/** Resolve the issues whose spend counts toward a caste limit (used by tests and diagnostics). */
export async function issueIdsOfRole(db: Db, companyId: string, role: string): Promise<string[]> {
  const rows = await db
    .select({ issueId: issues.id })
    .from(issues)
    .innerJoin(agents, eq(agents.id, issues.assigneeAgentId))
    .where(and(eq(issues.companyId, companyId), eq(agents.role, role)));
  return rows.map((row) => row.issueId);
}
