// server/src/myrmidon/budget-enforcement/settings.ts
//
// myrmidon(1.7-BUDGET-CONFIG-B): where the budget enforcement mode lives and
// how it survives every vendor write of `instance_settings.general`.
//
// The mode is read at evaluation time (not cached at boot), so a settings-page
// change reaches the next budget evaluation without a server restart. The
// environment variable stays a forced override for an instance that never
// saved the setting — the same precedence shape RUNTIME-LIMITS uses.

import {
  BUDGET_ENFORCEMENT_MODE_ENV,
  BUDGET_ENFORCEMENT_SETTINGS_KEY,
  normalizeBudgetEnforcementSettings,
  resolveBudgetEnforcement,
  type BudgetEnforcementMode,
  type BudgetEnforcementSource,
  type ResolvedBudgetEnforcement,
} from "@paperclipai/shared";

export { BUDGET_ENFORCEMENT_MODE_ENV, BUDGET_ENFORCEMENT_SETTINGS_KEY };

/** The deps the reader needs, so tests can run it without a database. */
export interface BudgetEnforcementSettingsDeps {
  getGeneral(): Promise<{ budgetEnforcement?: unknown }>;
  env?: Record<string, string | undefined>;
}

export interface BudgetEnforcementView {
  mode: BudgetEnforcementMode;
  source: BudgetEnforcementSource;
}

/**
 * The mode in force right now and where it came from. A settings read failure
 * fails SAFE-OPEN: the default `signal_only` mode (limits do not stop work)
 * is the shipped default, so a transient read error cannot wedge the company
 * into an unintended pause.
 */
export async function readBudgetEnforcement(
  deps: BudgetEnforcementSettingsDeps,
): Promise<ResolvedBudgetEnforcement> {
  let stored: unknown;
  try {
    const general = await deps.getGeneral();
    stored = general?.[BUDGET_ENFORCEMENT_SETTINGS_KEY];
  } catch {
    stored = undefined;
  }
  return resolveBudgetEnforcement({
    stored,
    env: deps.env ?? process.env,
  });
}

/** The stored settings value, normalized; null when the row has nothing usable. */
export function normalizeStoredBudgetEnforcement(raw: unknown): { mode: BudgetEnforcementMode } | null {
  return normalizeBudgetEnforcementSettings(raw);
}

/** Keep the stored mode across every vendor general write (same shape as WIP-LIMIT). */
export function preserveBudgetEnforcementGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[BUDGET_ENFORCEMENT_SETTINGS_KEY];
  return value === undefined ? {} : { [BUDGET_ENFORCEMENT_SETTINGS_KEY]: value };
}
