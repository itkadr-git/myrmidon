// server/src/myrmidon/tool-policy-cache/settings.ts
//
// myrmidon(DB-PERF-C-P4): read and write `instance_settings.general.toolPolicyCache`.
//
// The stored value is the single truth (no environment fallback — the TTL is a
// policy choice of the operator, not a deployment knob); an absent or malformed
// row means the default. The cache re-reads the row on every access, so a
// change applies without a restart.

import {
  TOOL_POLICY_CACHE_SETTINGS_KEY,
  applyToolPolicyCachePatch,
  normalizeToolPolicyCacheSettings,
  type PatchToolPolicyCacheSettings,
  type ToolPolicyCacheSettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export { TOOL_POLICY_CACHE_SETTINGS_KEY };

export type ToolPolicyCacheSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** The settings of the given `general` document, or the defaults when absent. */
export function readStoredToolPolicyCacheSettings(general: unknown): ToolPolicyCacheSettings {
  if (general === null || typeof general !== "object" || Array.isArray(general)) return {};
  return normalizeToolPolicyCacheSettings((general as Record<string, unknown>)[TOOL_POLICY_CACHE_SETTINGS_KEY]);
}

/** Read the settings from the instance row. */
export async function readToolPolicyCacheSettings(
  settings: Pick<ToolPolicyCacheSettingsService, "getGeneral">,
): Promise<ToolPolicyCacheSettings> {
  return readStoredToolPolicyCacheSettings(await settings.getGeneral());
}

/** Validate and store the full settings object (PUT semantics). */
export async function writeToolPolicyCacheSettings(
  settings: Pick<ToolPolicyCacheSettingsService, "getGeneral" | "updateGeneral">,
  input: ToolPolicyCacheSettings,
): Promise<ToolPolicyCacheSettings> {
  const next = normalizeToolPolicyCacheSettings(input);
  await settings.updateGeneral({ [TOOL_POLICY_CACHE_SETTINGS_KEY]: next });
  return next;
}

/** Apply a PATCH body to the stored settings: `null` clears the field. */
export async function patchToolPolicyCacheSettings(
  settings: Pick<ToolPolicyCacheSettingsService, "getGeneral" | "updateGeneral">,
  patch: PatchToolPolicyCacheSettings,
): Promise<ToolPolicyCacheSettings> {
  const stored = await readToolPolicyCacheSettings(settings);
  const next = applyToolPolicyCachePatch(stored, patch);
  await settings.updateGeneral({ [TOOL_POLICY_CACHE_SETTINGS_KEY]: next });
  return next;
}

/**
 * Keep the stored key across vendor writes of `instance_settings.general` —
 * the same contract every other myrmidon general key follows.
 */
export function preserveToolPolicyCacheGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[TOOL_POLICY_CACHE_SETTINGS_KEY];
  return value === undefined ? {} : { [TOOL_POLICY_CACHE_SETTINGS_KEY]: value };
}