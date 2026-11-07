// packages/shared/src/myrmidon-budget-config.ts
//
// myrmidon(1.7-BUDGET-CONFIG-READ): the read contract of GET
// /api/myrmidon/companies/:companyId/budget-limits/config — the budget
// hierarchy tree (nest → caste → foraging → ticket) with the hard/soft mode
// of every configured row plus the per-level defaults. The stored rows live
// in the budget-limits store; this module is the pure projection the route
// serves and the UI reads.
//
// Naming: the API speaks «ticket»; the budget-limits store rows keep their
// historical «issue» level name. The projection maps one to the other so
// both halves keep their vocabulary.
//
// Shape: a level is «available» when it can be read at all; «configured»
// when at least one row exists at that level. Every row keeps its own
// hard/soft mode; a level without rows reports the built-in default
// (soft, calendar_month_utc, no amount) — «отсутствующий уровень → дефолт».

import {
  BUDGET_LIMIT_LEVELS,
  BUDGET_LIMIT_MODES,
  BUDGET_LIMIT_PERIODS,
  type BudgetLimitLevel,
  type BudgetLimitMode,
  type BudgetLimitPeriod,
  type BudgetLimitView,
} from "./myrmidon-budget-limits.js";

// Re-exported so consumers of the config projection can reference the row
// shape without importing from two modules; the TS2459 in the projection
// test (importing BudgetLimitView from this module) is fixed by this.
export type { BudgetLimitView };

/** The four levels the config tree exposes, outermost first. */
export const BUDGET_CONFIG_LEVELS = ["nest", "caste", "foraging", "ticket"] as const;
export type BudgetConfigLevel = (typeof BUDGET_CONFIG_LEVELS)[number];

/** The store level a config level reads from. */
export const BUDGET_CONFIG_LEVEL_TO_STORE_LEVEL: Record<BudgetConfigLevel, BudgetLimitLevel> = {
  nest: "nest",
  caste: "caste",
  foraging: "foraging",
  ticket: "issue",
};

/** Built-in defaults applied when a level has no configured row. */
export const BUDGET_CONFIG_DEFAULTS = {
  period: "calendar_month_utc",
  mode: "soft",
} as const satisfies { period: BudgetLimitPeriod; mode: BudgetLimitMode };

/** The hard/soft answer of one configured row (the row keeps its mode). */
export interface BudgetConfigLimitEntry {
  /** The store ref this row sits on (project uuid or "company", role key, "foraging", issue uuid). */
  ref: string;
  amountCents: number;
  period: BudgetLimitPeriod;
  mode: BudgetLimitMode;
  isActive: boolean;
  row: BudgetLimitView;
}

/** One node of the hierarchy tree. */
export interface BudgetConfigLevelView {
  level: BudgetConfigLevel;
  /**
   * False when the level cannot be read for the requested scope — e.g. a
   * ticket-scoped read of an issue that does not exist in this company.
   * Unavailable levels carry no rows and no defaults.
   */
  available: boolean;
  /** True when at least one row is configured at this level. */
  configured: boolean;
  /** All configured rows at this level (active and inactive), sorted by ref. */
  limits: BudgetConfigLimitEntry[];
  /** The defaults a missing level falls back to. */
  defaults: {
    period: BudgetLimitPeriod;
    mode: BudgetLimitMode;
  };
  /** True when no row exists and the defaults describe the level. */
  isDefault: boolean;
}

/** The full config response of GET …/budget-limits/config. */
export interface BudgetConfigView {
  companyId: string;
  signalOnly: boolean;
  signalOnlySource: "default" | "stored" | "env";
  levels: Record<BudgetConfigLevel, BudgetConfigLevelView>;
}

/** Input of the pure projection: the rows of one company plus the flag. */
export interface BudgetConfigInput {
  companyId: string;
  limits: BudgetLimitView[];
  signalOnly: boolean;
  signalOnlySource: "default" | "stored" | "env";
  /**
   * Optional ticket scope: when set, the ticket level lists only the row for
   * this issue id and is unavailable when no such issue exists in this
   * company (the route answers 404 for that read). When absent, the ticket
   * level lists all ticket rows (none by default — tickets are too many to
   * enumerate usefully, so the level reports its defaults).
   */
  ticketIssueId?: string | null;
  ticketAvailable?: boolean;
}

function defaults(): { period: BudgetLimitPeriod; mode: BudgetLimitMode } {
  return { period: BUDGET_CONFIG_DEFAULTS.period, mode: BUDGET_CONFIG_DEFAULTS.mode };
}

function entry(row: BudgetLimitView): BudgetConfigLimitEntry {
  return {
    ref: row.ref,
    amountCents: row.amountCents,
    period: row.period,
    mode: row.mode,
    isActive: row.isActive,
    row,
  };
}

function projectLevel(
  level: BudgetConfigLevel,
  rows: BudgetLimitView[],
  available = true,
): BudgetConfigLevelView {
  const sorted = [...rows].sort((a, b) => a.ref.localeCompare(b.ref)).map(entry);
  return {
    level,
    available,
    configured: sorted.length > 0,
    limits: sorted,
    defaults: defaults(),
    isDefault: sorted.length === 0,
  };
}

/**
 * The pure projection behind GET …/budget-limits/config: one entry per
 * hierarchy level, outermost first, each carrying its configured rows with
 * their own hard/soft modes, or the built-in default when no row exists
 * («отсутствующий уровень → дефолт»). An unresolvable ticket scope makes the
 * ticket level unavailable instead of defaulted.
 */
export function buildBudgetConfig(input: BudgetConfigInput): BudgetConfigView {
  const byStoreLevel = (storeLevel: BudgetLimitLevel) =>
    input.limits.filter((item) => item.level === storeLevel);
  const levels = {} as Record<BudgetConfigLevel, BudgetConfigLevelView>;
  levels.nest = projectLevel("nest", byStoreLevel("nest"));
  levels.caste = projectLevel("caste", byStoreLevel("caste"));
  levels.foraging = projectLevel("foraging", byStoreLevel("foraging"));
  if (input.ticketIssueId) {
    levels.ticket = projectLevel(
      "ticket",
      byStoreLevel("issue").filter((row) => row.ref === input.ticketIssueId),
      input.ticketAvailable !== false,
    );
  } else {
    levels.ticket = projectLevel("ticket", [], input.ticketAvailable !== false);
  }
  return {
    companyId: input.companyId,
    signalOnly: input.signalOnly,
    signalOnlySource: input.signalOnlySource,
    levels,
  };
}

/** The list of the underlying store levels (kept for diagnostics/tests). */
export const BUDGET_CONFIG_STORE_LEVELS = BUDGET_LIMIT_LEVELS;
export const BUDGET_CONFIG_MODES = BUDGET_LIMIT_MODES;
export const BUDGET_CONFIG_PERIODS = BUDGET_LIMIT_PERIODS;
