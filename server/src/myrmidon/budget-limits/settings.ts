// server/src/myrmidon/budget-limits/settings.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): read and write
// `instance_settings.general.budgetLimits` — the global "signal only" flag.
//
// The stored value is the single truth; absent or malformed means the default
// (signal only ON — corrupt data must never silently arm enforcement). The env
// variable is a FORCED override, resolved read-time and reported with its
// source, so the screen can show where the value comes from; this module is
// the database half only.

import {
  BUDGET_LIMITS_SETTINGS_KEY,
  normalizeBudgetLimitsSettings,
  resolveBudgetLimitsSignalOnly,
  type BudgetLimitsSettings,
  type ResolvedBudgetLimitsSignalOnly,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type BudgetLimitsSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** Read the raw stored settings (or the defaults when absent). */
export async function readBudgetLimitsSettings(
  settings: BudgetLimitsSettingsService,
): Promise<BudgetLimitsSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizeBudgetLimitsSettings(general[BUDGET_LIMITS_SETTINGS_KEY]);
}

/** Read the effective signal-only flag with its source (env wins, forced). */
export async function readResolvedSignalOnly(
  settings: BudgetLimitsSettingsService,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedBudgetLimitsSignalOnly> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return resolveBudgetLimitsSignalOnly(general[BUDGET_LIMITS_SETTINGS_KEY], env);
}

/** Validate and store the full settings object (PATCH semantics). */
export async function writeBudgetLimitsSignalOnly(
  settings: BudgetLimitsSettingsService,
  signalOnly: boolean,
): Promise<BudgetLimitsSettings> {
  const next: BudgetLimitsSettings = { signalOnly };
  await settings.updateGeneral({ [BUDGET_LIMITS_SETTINGS_KEY]: next });
  return next;
}

/**
 * Keep the stored key across vendor writes of `instance_settings.general` —
 * the same contract every other myrmidon general key follows.
 */
export function preserveBudgetLimitsGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[BUDGET_LIMITS_SETTINGS_KEY];
  return value === undefined ? {} : { [BUDGET_LIMITS_SETTINGS_KEY]: value };
}
