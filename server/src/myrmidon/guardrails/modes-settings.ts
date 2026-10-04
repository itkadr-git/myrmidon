// server/src/myrmidon/guardrails/modes-settings.ts
//
// myrmidon(1.7-GRD-MODES): read and write
// `instance_settings.general.guardrailModes` (OPE-4167). The same storage
// rule wipLimit and the autonomy matrix follow: the vendor settings service
// strips unknown keys, so the module reads and writes the raw row through
// getGeneral/updateGeneral and registers a preserve* helper. No migration; an
// old image keeps working on the new schema. A mode change takes effect on
// the next guardrail evaluation — no restart.

import {
  EMPTY_GUARDRAIL_MODES_SETTINGS,
  GUARDRAIL_MODES_SETTINGS_KEY,
  normalizeGuardrailModesSettings,
  guardrailModesSettingsSchema,
  type GuardrailModesSettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type GuardrailModesSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** Read the mode overrides of the instance (defaults when absent). */
export async function readGuardrailModesSettings(
  settings: GuardrailModesSettingsService,
): Promise<GuardrailModesSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizeGuardrailModesSettings(general[GUARDRAIL_MODES_SETTINGS_KEY]);
}

/** Validate and store the full settings object (PUT semantics). */
export async function writeGuardrailModesSettings(
  settings: GuardrailModesSettingsService,
  input: GuardrailModesSettings,
): Promise<GuardrailModesSettings> {
  const parsed = guardrailModesSettingsSchema.parse(input);
  await settings.updateGeneral({ [GUARDRAIL_MODES_SETTINGS_KEY]: parsed });
  return parsed;
}

/**
 * Keep the stored key across vendor writes of `instance_settings.general` —
 * the same contract every other myrmidon general key follows.
 */
export function preserveGuardrailModesGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[GUARDRAIL_MODES_SETTINGS_KEY];
  return value === undefined ? {} : { [GUARDRAIL_MODES_SETTINGS_KEY]: value };
}

export { EMPTY_GUARDRAIL_MODES_SETTINGS };
