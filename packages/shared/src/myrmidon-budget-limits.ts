// packages/shared/src/myrmidon-budget-limits.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): the shared contract of the per-level spend
// limits — the schema the API validates with, the level semantics, the
// resolution of "signal only" from stored settings + env override, and the
// "spent in period" window math. The server module (store, routes, usage) is
// the other half; the UI (a later part) reads exactly this contract.
//
// The stored settings live in `instance_settings.general.budgetLimits`:
//
//   { signalOnly: boolean }
//
// `signalOnly` defaults to TRUE (the global "signal only" mode: limits never
// stop work until the owner explicitly turns it off). The env variable
// `MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY` is a forced override only — when it is
// set, it wins over the stored value, and the source of the effective value is
// reported so the screen can show where the value comes from.

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its settings under. */
export const BUDGET_LIMITS_SETTINGS_KEY = "budgetLimits";

/** Env forced override of the stored signal-only flag. */
export const BUDGET_LIMITS_SIGNAL_ONLY_ENV = "MYRMIDON_BUDGET_LIMITS_SIGNAL_ONLY";

/** The hierarchy levels a limit can sit on (vendor budget scope is only company/agent/project; this adds the hierarchy). */
export const BUDGET_LIMIT_LEVELS = ["nest", "caste", "foraging", "issue"] as const;
export type BudgetLimitLevel = (typeof BUDGET_LIMIT_LEVELS)[number];

/** The period a limit is counted over — the same windows vendor budget policies use. */
export const BUDGET_LIMIT_PERIODS = ["calendar_month_utc", "lifetime"] as const;
export type BudgetLimitPeriod = (typeof BUDGET_LIMIT_PERIODS)[number];

/** hard = refuse; soft = pause + card to the owner ("extend by $N or stop"). */
export const BUDGET_LIMIT_MODES = ["hard", "soft"] as const;
export type BudgetLimitMode = (typeof BUDGET_LIMIT_MODES)[number];

/** The ref of the nest level: a project uuid, or this literal for the company itself. */
export const BUDGET_LIMIT_NEST_COMPANY_REF = "company";

/** The ref of the foraging level: one literal, the foraging pass. */
export const BUDGET_LIMIT_FORAGING_REF = "foraging";

// --- settings ----------------------------------------------------------------

/** Body of `PATCH …/budget-limits/signal-only` — one boolean. */
export const budgetLimitsSignalOnlySchema = z
  .object({
    signalOnly: z.boolean(),
  })
  .strict();
export type BudgetLimitsSignalOnlyInput = z.infer<typeof budgetLimitsSignalOnlySchema>;

/** The stored settings shape (raw in the general block). */
export const budgetLimitsSettingsSchema = z
  .object({
    signalOnly: z.boolean(),
  })
  .strict();
export type BudgetLimitsSettings = z.infer<typeof budgetLimitsSettingsSchema>;

/**
 * The settings as stored, or the implicit default (signal only ON) when
 * absent or unreadable — corrupt data must never silently turn limits into
 * hard enforcement.
 */
export function normalizeBudgetLimitsSettings(raw: unknown): BudgetLimitsSettings {
  const parsed = budgetLimitsSettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return { signalOnly: true };
}

/** Where the effective signal-only value came from. */
export type BudgetLimitsSignalOnlySource = "default" | "stored" | "env";

export interface ResolvedBudgetLimitsSignalOnly {
  signalOnly: boolean;
  source: BudgetLimitsSignalOnlySource;
}

/**
 * Resolve the global "signal only" mode: stored settings win over the default;
 * the env variable is a FORCED override that wins over both and is reported
 * with source "env" so screens can show the origin.
 * Accepted env values: `1`/`true`/`yes`/`on` → true; `0`/`false`/`no`/`off` →
 * false; anything else is ignored (a typo never flips the owner's choice).
 */
export function resolveBudgetLimitsSignalOnly(
  stored: unknown,
  env: Record<string, string | undefined>,
): ResolvedBudgetLimitsSignalOnly {
  const raw = env[BUDGET_LIMITS_SIGNAL_ONLY_ENV]?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return { signalOnly: true, source: "env" };
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return { signalOnly: false, source: "env" };
  }
  const normalized = normalizeBudgetLimitsSettings(stored);
  if (budgetLimitsSettingsSchema.safeParse(stored).success) {
    return { signalOnly: normalized.signalOnly, source: "stored" };
  }
  return { signalOnly: normalized.signalOnly, source: "default" };
}

// --- limit rows ----------------------------------------------------------------

/** Body of `PUT …/budget-limits/limits/:level/:ref` — the full limit row. */
export const budgetLimitUpsertSchema = z
  .object({
    amountCents: z.number().int().min(0).max(1_000_000_000),
    period: z.enum(BUDGET_LIMIT_PERIODS).default("calendar_month_utc"),
    mode: z.enum(BUDGET_LIMIT_MODES).default("hard"),
    isActive: z.boolean().default(true),
  })
  .strict();
export type BudgetLimitUpsertInput = z.infer<typeof budgetLimitUpsertSchema>;

/** One limit row as the API returns it. */
export interface BudgetLimitView {
  id: string;
  companyId: string;
  level: BudgetLimitLevel;
  ref: string;
  amountCents: number;
  period: BudgetLimitPeriod;
  mode: BudgetLimitMode;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One journal entry as the API returns it: who, when, what. */
export interface BudgetLimitChangeView {
  id: string;
  companyId: string;
  /** Null when the limit row was deleted after this entry (history survives). */
  limitId: string | null;
  action: "create" | "update" | "delete";
  level: BudgetLimitLevel;
  ref: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actorType: string;
  actorId: string;
  at: string;
}

// --- "spent in period" -----------------------------------------------------------

export interface BudgetLimitWindow {
  start: Date | null;
  end: Date | null;
}

/**
 * The UTC window a period counts over — the same math the vendor budget
 * service uses (`calendar_month_utc` is the [first day of the current UTC
 * month, first day of the next), `lifetime` is unbounded).
 */
export function budgetLimitWindow(period: BudgetLimitPeriod, now: Date = new Date()): BudgetLimitWindow {
  if (period === "lifetime") return { start: null, end: null };
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)),
  };
}

/**
 * Whether a limit at this level is over the observed spend. `signalOnly`
 * does not change this predicate — it changes what the caller DOES with the
 * answer (see the guide: signal mode never stops work).
 */
export function isBudgetLimitOver(
  limit: { amountCents: number; isActive: boolean },
  spentCents: number,
): boolean {
  return limit.isActive && limit.amountCents >= 0 && spentCents > limit.amountCents;
}
