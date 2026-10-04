import { z } from "zod";

/**
 * Budget enforcement mode (myrmidon 1.7 BUDGET-CONFIG B, BUD2).
 *
 * A budget policy that crosses its hard threshold used to have exactly one
 * vendor behaviour: pause the scope, cancel the runs, wait for the owner.
 * This contract adds one global switch, stored in
 * `instance_settings.general.budgetEnforcement`, that decides what the SAME
 * incident means while it is open:
 *
 * - `signal_only` — the default. The incident is created and the owner is
 *   signalled (issue thread + the decision inbox budget card), but the scope
 *   is NOT paused and new runs are NOT refused: limits only signal.
 * - `soft` — the scope is paused and the owner gets a "raise by $N or stop"
 *   card. Runs of the paused scope are held, not cancelled-and-forgotten;
 *   raising the budget (the card action, the same
 *   `raise_budget_and_resume` path the vendor incident resolution already
 *   has) resumes the scope and the held runs start again.
 * - `hard` — new runs of the over-limit scope are refused with the budget
 *   reason before they start (the vendor `getInvocationBlock` behaviour,
 *   now conditional on the mode instead of always-on).
 *
 * Precedence, per the RUNTIME-LIMITS shape: the stored settings value when
 * `general.budgetEnforcement.mode` is present; otherwise the environment
 * variable `MYRMIDON_BUDGET_ENFORCEMENT_MODE` (forced override, deployment
 * use); otherwise the built-in default `signal_only`. The owner turns
 * enforcement on or off from the settings page; the environment stays an
 * override for an instance that never saved the setting.
 */

/** Where the mode lives in the environment. */
export const BUDGET_ENFORCEMENT_MODE_ENV = "MYRMIDON_BUDGET_ENFORCEMENT_MODE";

/** The stored key inside `instance_settings.general`. */
export const BUDGET_ENFORCEMENT_SETTINGS_KEY = "budgetEnforcement";

/** The three behaviours a crossed limit can have. */
export const BUDGET_ENFORCEMENT_MODES = ["signal_only", "soft", "hard"] as const;
export type BudgetEnforcementMode = (typeof BUDGET_ENFORCEMENT_MODES)[number];

/** Where an effective value came from. */
export type BudgetEnforcementSource = "settings" | "env" | "default";

/** The canonical stored shape of `general.budgetEnforcement`. */
export const budgetEnforcementSettingsSchema = z
  .object({
    mode: z.enum(BUDGET_ENFORCEMENT_MODES),
  })
  .strict();

export type BudgetEnforcementSettings = z.infer<typeof budgetEnforcementSettingsSchema>;

/** Body of `PATCH /api/myrmidon/budget-enforcement`. */
export const patchBudgetEnforcementSchema = z
  .object({
    mode: z.enum(BUDGET_ENFORCEMENT_MODES),
  })
  .strict();

export type BudgetEnforcementPatch = z.infer<typeof patchBudgetEnforcementSchema>;

export interface ResolvedBudgetEnforcement {
  mode: BudgetEnforcementMode;
  source: BudgetEnforcementSource;
}

/** The default until the owner explicitly switches it off: only signal. */
export const DEFAULT_BUDGET_ENFORCEMENT_MODE: BudgetEnforcementMode = "signal_only";

/** An environment value as a mode; anything unreadable reads as unset. */
export function parseBudgetEnforcementMode(
  raw: string | undefined,
): BudgetEnforcementMode | null {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed === "signal_only" || trimmed === "soft" || trimmed === "hard") return trimmed;
  return null;
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeBudgetEnforcementSettings(raw: unknown): BudgetEnforcementSettings | null {
  const parsed = budgetEnforcementSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective mode and where it came from. An unreadable stored value counts
 * as absent, so the environment (or the default) applies instead — a
 * hand-edited row cannot wedge the budgets into a mode nobody chose.
 */
export function resolveBudgetEnforcement(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedBudgetEnforcement {
  const stored = normalizeBudgetEnforcementSettings(options.stored);
  if (stored) {
    return { mode: stored.mode, source: "settings" };
  }
  const fromEnv = parseBudgetEnforcementMode(
    (options.env ?? {})[BUDGET_ENFORCEMENT_MODE_ENV],
  );
  if (fromEnv) {
    return { mode: fromEnv, source: "env" };
  }
  return { mode: DEFAULT_BUDGET_ENFORCEMENT_MODE, source: "default" };
}

/** True when the mode stops anything at all (soft pauses, hard refuses). */
export function budgetEnforcementStopsWork(mode: BudgetEnforcementMode): boolean {
  return mode === "soft" || mode === "hard";
}
