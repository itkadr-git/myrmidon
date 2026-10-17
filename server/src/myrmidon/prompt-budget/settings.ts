// server/src/myrmidon/prompt-budget/settings.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): read and write
// `instance_settings.general.promptBudget`.
//
// The stored value is the single truth and changes live (no restart): the
// sweep re-reads it on every pass and the status route on every request. An
// absent or malformed row normalizes to the defaults (warn 70, crit 90,
// enabled, 200k fallback window), so a hand-edited row can never half-apply.
// The same seam the wip-limit module uses.

import {
  PROMPT_BUDGET_SETTINGS_KEY,
  normalizePromptBudgetSettings,
  promptBudgetSettingsSchema,
  type PromptBudgetSettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type PromptBudgetSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** Read the settings (or the defaults when absent). */
export async function readPromptBudgetSettings(
  settings: PromptBudgetSettingsService,
): Promise<PromptBudgetSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizePromptBudgetSettings(general[PROMPT_BUDGET_SETTINGS_KEY]);
}

/** Validate and store the full settings object (PUT semantics). */
export async function writePromptBudgetSettings(
  settings: PromptBudgetSettingsService,
  input: PromptBudgetSettings,
): Promise<PromptBudgetSettings> {
  const parsed = promptBudgetSettingsSchema.parse(input);
  await settings.updateGeneral({ [PROMPT_BUDGET_SETTINGS_KEY]: parsed });
  return parsed;
}
