// server/src/myrmidon/prompt-budget-advice/settings.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET C): read the optimizer agent id.
//
// The key lives inside the prompt-budget settings area of the same release:
// `instance_settings.general.promptBudget.optimizerAgentId`. The area itself
// (its schema, its PUT route, its panel) belongs to the thresholds part, so this
// module only READS one additive field of it — a value the operator picks on the
// same settings panel. Nothing here writes the area.
//
// A missing, blank or non-uuid value reads as "not configured": an operator
// typo must answer with the clear 422 of the deep route, not with a task
// assigned to a garbage id.

/** The `instance_settings.general` key of the prompt-budget area. */
export const PROMPT_BUDGET_SETTINGS_KEY = "promptBudget";

/** The field of that area naming the optimizer agent. */
export const PROMPT_BUDGET_OPTIMIZER_FIELD = "optimizerAgentId";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A usable agent id, or null for anything that is not one. */
export function normalizeOptimizerAgentId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return UUID_RE.test(value) ? value.toLowerCase() : null;
}

/** Pull the optimizer agent id out of a stored general-settings object. */
export function readOptimizerAgentIdFromGeneral(general: unknown): string | null {
  if (typeof general !== "object" || general === null) return null;
  const area = (general as Record<string, unknown>)[PROMPT_BUDGET_SETTINGS_KEY];
  if (typeof area !== "object" || area === null || Array.isArray(area)) return null;
  return normalizeOptimizerAgentId((area as Record<string, unknown>)[PROMPT_BUDGET_OPTIMIZER_FIELD]);
}

/** The slice of the instance-settings service this module reads through. */
export interface PromptBudgetSettingsService {
  getGeneral(): Promise<unknown>;
}

/** The configured optimizer agent id, or null when it is absent or unusable. */
export async function readPromptBudgetOptimizerAgentId(
  settings: PromptBudgetSettingsService,
): Promise<string | null> {
  return readOptimizerAgentIdFromGeneral(await settings.getGeneral());
}