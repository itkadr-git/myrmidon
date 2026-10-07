// server/src/myrmidon/debates/settings.ts
//
// myrmidon(1.7-DEBATE-ASYM-A): where the debate engine configuration lives
// and how it survives every vendor write of `instance_settings.general`.
//
// Same shape as BUDGET-CONFIG-B / RUNTIME-LIMITS: the stored row is the
// source of truth once an operator saves it; `MYRMIDON_DEBATE_CONFIG` stays
// the forced environment override for an instance that never did. The value
// is read at run/PATCH time — never cached at boot — so a settings-page
// change reaches the next debate without a server restart, and the GET
// endpoint reports the source of the effective value.

import {
  DEBATE_SETTINGS_ENV,
  DEBATE_SETTINGS_KEY,
  resolveDebateSettings,
  type DebateSettingsResolution,
} from "@paperclipai/shared";

export { DEBATE_SETTINGS_ENV, DEBATE_SETTINGS_KEY };

/** The deps the reader needs, so tests can run it without a database. */
export interface DebateSettingsDeps {
  getGeneral(): Promise<{ debate?: unknown }>;
  env?: Record<string, string | undefined>;
}

/**
 * The effective configuration and its source. A stored read failure fails
 * open to the environment/default level: a transient error cannot hide the
 * built-in (already valid, free-model) configuration.
 */
export async function readDebateSettings(deps: DebateSettingsDeps): Promise<DebateSettingsResolution> {
  let stored: unknown;
  try {
    const general = await deps.getGeneral();
    stored = general?.[DEBATE_SETTINGS_KEY];
  } catch {
    stored = undefined;
  }
  return resolveDebateSettings({ stored, env: deps.env ?? process.env });
}

/** Keep the stored debate config across every vendor general write (same shape as WIP-LIMIT). */
export function preserveDebateGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  if (!Object.prototype.hasOwnProperty.call(storedGeneral, DEBATE_SETTINGS_KEY)) return {};
  return { [DEBATE_SETTINGS_KEY]: (storedGeneral as Record<string, unknown>)[DEBATE_SETTINGS_KEY] };
}
