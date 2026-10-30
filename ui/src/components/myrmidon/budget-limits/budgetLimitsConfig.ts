// myrmidon(1.7 BUDGET-CONFIG D): pure helpers of the "Budgets" screen — the
// tree the owner sees, the amount/ref parsing and the label keys. No React, no
// network: unit-testable as is.
//
// The tree mirrors the limit hierarchy the API stores (one row per
// `(company, level, ref)`): nest (the company and every project) → caste (a role
// key) → foraging (one pass) → task (an issue uuid). A node without a stored row
// is still rendered — the owner sets a limit where none exists yet — and its
// spend is `null` (the usage endpoint only reports stored rows).
//
// Every user-visible string is a translation key: the catalog lives in
// `ui/src/i18n/myrmidon-locales/{en,ru}.json` under `budgetLimits.*`.

import {
  BUDGET_LIMIT_FORAGING_REF,
  BUDGET_LIMIT_NEST_COMPANY_REF,
  type BudgetLimitLevel,
  type BudgetLimitMode,
  type BudgetLimitPeriod,
  type BudgetLimitUsageRow,
  type BudgetLimitView,
} from "./budgetLimitsApi";

/** UI sanity bound for one amount, mirroring the API schema (1_000_000_000 cents). */
export const BUDGET_LIMIT_AMOUNT_MAX_CENTS = 1_000_000_000;

/** The rows the usage endpoint can answer for; a stored row without usage reads as 0. */
export interface BudgetLimitNode {
  /** Stable identity of the row: `level:ref`, also the react key and the draft key. */
  key: string;
  level: BudgetLimitLevel;
  ref: string;
  /** The stored row, or null when this row's limit is not set yet. */
  limit: BudgetLimitView | null;
  /** Depth in the tree: nest/company=0, projects=1, caste=1, foraging=1, task=1. */
  depth: number;
  /** The ref as a translation key, when it is a fixed one (company, foraging). */
  fixedRefLabelKey: string | null;
  /** The ref as a human label from a directory (project name), otherwise null. */
  refLabel: string | null;
  /** Spend in the row's period, or null when the row has no stored limit. */
  spentCents: number | null;
  overLimit: boolean;
}

export interface BudgetLimitTree {
  nest: BudgetLimitNode[];
  caste: BudgetLimitNode[];
  foraging: BudgetLimitNode[];
  issue: BudgetLimitNode[];
}

export interface BudgetLimitProjectRef {
  id: string;
  name: string;
}

export interface BuildBudgetLimitTreeInput {
  limits: BudgetLimitView[];
  /** Usage rows from the usage endpoint; a stored row missing here reads as 0 spend. */
  usage: BudgetLimitUsageRow[];
  /** Projects of the company — the nest level lists one row per project. */
  projects: BudgetLimitProjectRef[];
  /**
   * Refs the owner just added on screen but has not saved yet: the row appears
   * with no limit so its amount can be typed before the first save.
   */
  extraRefs?: Array<{ level: BudgetLimitLevel; ref: string }>;
}

/** `level:ref` — the identity of one row, used as react key and draft key. */
export function budgetLimitKey(level: BudgetLimitLevel, ref: string): string {
  return `${level}:${ref}`;
}

function node(
  level: BudgetLimitLevel,
  ref: string,
  limit: BudgetLimitView | null,
  extras: {
    depth: number;
    fixedRefLabelKey?: string | null;
    refLabel?: string | null;
    spentCents?: number | null;
    overLimit?: boolean;
  },
): BudgetLimitNode {
  return {
    key: budgetLimitKey(level, ref),
    level,
    ref,
    limit,
    depth: extras.depth,
    fixedRefLabelKey: extras.fixedRefLabelKey ?? null,
    refLabel: extras.refLabel ?? null,
    spentCents: extras.spentCents ?? null,
    overLimit: extras.overLimit ?? false,
  };
}

/**
 * The tree the screen renders: the company nest first, then one nest row per
 * project, then castes that have a limit, then foraging, then task limits. Rows
 * without a stored limit are included for the fixed refs (company, foraging) and
 * for every project; free-ref levels (caste, task) list the stored rows only —
 * a new ref is added through the "add a limit" control.
 */
export function buildBudgetLimitTree({
  limits,
  usage,
  projects,
  extraRefs = [],
}: BuildBudgetLimitTreeInput): BudgetLimitTree {
  const usageByKey = new Map<string, BudgetLimitUsageRow>(
    usage.map((row) => [budgetLimitKey(row.level, row.ref), row]),
  );
  const limitsByKey = new Map<string, BudgetLimitView>(
    limits.map((row) => [budgetLimitKey(row.level, row.ref), row]),
  );

  const rowNode = (level: BudgetLimitLevel, ref: string, depth: number, extras: Partial<BudgetLimitNode> = {}): BudgetLimitNode => {
    const key = budgetLimitKey(level, ref);
    const limit = limitsByKey.get(key) ?? null;
    const usageRow = usageByKey.get(key) ?? null;
    const spentCents = limit ? (usageRow?.spentCents ?? 0) : null;
    return node(level, ref, limit, {
      depth,
      spentCents,
      overLimit: limit ? (usageRow?.overLimit ?? false) : false,
      ...extras,
    });
  };

  const nest: BudgetLimitNode[] = [
    rowNode("nest", BUDGET_LIMIT_NEST_COMPANY_REF, 0, { fixedRefLabelKey: "budgetLimits.refCompany" }),
  ];
  const projectIds = new Set(projects.map((project) => project.id));
  for (const project of projects) {
    nest.push(rowNode("nest", project.id, 1, { refLabel: project.name }));
  }
  // A limit on an archived/unknown project still shows: history must not vanish.
  const extraKeys = new Set(extraRefs.map((extra) => budgetLimitKey(extra.level, extra.ref)));
  const distinctRefs = (level: BudgetLimitLevel): string[] => {
    const refs = new Set<string>(
      limits.filter((limit) => limit.level === level).map((limit) => limit.ref),
    );
    for (const extra of extraRefs) {
      if (extra.level === level) refs.add(extra.ref);
    }
    return [...refs].sort((a, b) => a.localeCompare(b));
  };

  for (const ref of distinctRefs("nest")) {
    if (ref === BUDGET_LIMIT_NEST_COMPANY_REF) continue;
    if (projectIds.has(ref)) continue;
    const key = budgetLimitKey("nest", ref);
    if (!extraKeys.has(key) && !limitsByKey.has(key)) continue;
    nest.push(rowNode("nest", ref, 1, { refLabel: null }));
  }

  const caste = distinctRefs("caste").map((ref) => rowNode("caste", ref, 1));

  const foraging: BudgetLimitNode[] = [
    rowNode("foraging", BUDGET_LIMIT_FORAGING_REF, 1, { fixedRefLabelKey: "budgetLimits.refForaging" }),
  ];

  const issue = distinctRefs("issue").map((ref) => rowNode("issue", ref, 1));

  return { nest, caste, foraging, issue };
}

/** All tree rows in render order, for tests and counters. */
export function flattenBudgetLimitTree(tree: BudgetLimitTree): BudgetLimitNode[] {
  return [...tree.nest, ...tree.caste, ...tree.foraging, ...tree.issue];
}

// --- money -------------------------------------------------------------------

/** `$12.34`; thousands get a comma. Values are integer cents, never floats. */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(Math.trunc(cents));
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${String(fraction).padStart(2, "0")}`;
}

/** The input draft of an amount: `12.50`, without the currency sign. */
export function centsToAmountText(cents: number | null | undefined): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "";
  return (cents / 100).toFixed(2);
}

export type AmountParse =
  | { ok: true; cents: number }
  | { ok: false; messageKey: string };

/**
 * Parse an amount draft into integer cents, rounding half-up at the third
 * decimal. Cents are never floats in the store, so the UI converts once, here.
 * Both ways of typing dollars-and-cents are accepted: a dot (`12.50`), a lone
 * comma as the decimal separator (`12,50`, the RU habit), and the English
 * thousands grouping (`1,234.56`).
 */
export function parseAmountToCents(text: string): AmountParse {
  const trimmed = text.trim().replace(/^\$/, "").replace(/\s/g, "");
  if (trimmed === "") return { ok: false, messageKey: "budgetLimits.amountRequired" };
  let normalized = trimmed;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    normalized = trimmed.replace(/,/g, "");
  } else if (/^\d+,\d{1,2}$/.test(trimmed)) {
    normalized = trimmed.replace(",", ".");
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return { ok: false, messageKey: "budgetLimits.amountInvalid" };
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > BUDGET_LIMIT_AMOUNT_MAX_CENTS) {
    return { ok: false, messageKey: "budgetLimits.amountRange" };
  }
  return { ok: true, cents };
}

// --- refs --------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a ref for a level exactly as the API does (part A,
 * `validateBudgetLimitRef`): a mismatched ref is refused by the server, so the
 * screen refuses to send it and names the rule instead.
 */
export function parseRefForLevel(level: BudgetLimitLevel, ref: string): { ok: true; ref: string } | { ok: false; messageKey: string } {
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return { ok: false, messageKey: "budgetLimits.refErrorLength" };
  }
  switch (level) {
    case "nest":
      if (trimmed !== BUDGET_LIMIT_NEST_COMPANY_REF && !UUID.test(trimmed)) {
        return { ok: false, messageKey: "budgetLimits.refErrorNest" };
      }
      return { ok: true, ref: trimmed };
    case "caste":
      if (!/^[a-z0-9-]{1,60}$/.test(trimmed)) {
        return { ok: false, messageKey: "budgetLimits.refErrorCaste" };
      }
      return { ok: true, ref: trimmed };
    case "foraging":
      if (trimmed !== BUDGET_LIMIT_FORAGING_REF) {
        return { ok: false, messageKey: "budgetLimits.refErrorForaging" };
      }
      return { ok: true, ref: trimmed };
    case "issue":
      if (!UUID.test(trimmed)) return { ok: false, messageKey: "budgetLimits.refErrorIssue" };
      return { ok: true, ref: trimmed };
  }
}

// --- labels ------------------------------------------------------------------

/** i18n key of a level name. */
export function levelLabelKey(level: BudgetLimitLevel): string {
  return `budgetLimits.level.${level}`;
}

/** i18n key of a period name. */
export function periodLabelKey(period: BudgetLimitPeriod): string {
  return `budgetLimits.period.${period}`;
}

/** i18n key of a mode name. */
export function modeLabelKey(mode: BudgetLimitMode): string {
  return `budgetLimits.mode.${mode}`;
}

/** i18n key of a journal action name. */
export function actionLabelKey(action: "create" | "update" | "delete"): string {
  return `budgetLimits.action.${action}`;
}

/** i18n key of where the effective "signal only" value came from. */
export function signalOnlySourceLabelKey(source: "default" | "stored" | "env"): string {
  return `budgetLimits.source.${source}`;
}

/** The ref label: a directory name, a fixed-ref key, or the raw ref for free refs. */
export function nodeRefText(nodeNode: BudgetLimitNode): { key: string } | { text: string } {
  if (nodeNode.refLabel) return { text: nodeNode.refLabel };
  if (nodeNode.fixedRefLabelKey) return { key: nodeNode.fixedRefLabelKey };
  return { text: nodeNode.ref };
}

/** Share of the limit already spent, 0–100, rounded; null when the limit is off. */
export function usagePercent(spentCents: number | null, amountCents: number | null | undefined): number | null {
  if (typeof amountCents !== "number" || amountCents <= 0 || spentCents === null) return null;
  return Math.min(100, Math.round((spentCents / amountCents) * 100));
}