// server/src/myrmidon/long-task-context/settings.ts
//
// myrmidon(1.6.6 LONG-TASK-CONTEXT): read and write
// `instance_settings.general.longTaskContext`, plus the environment overrides
// of a single run's process.
//
// The stored value is the single truth and changes live (no restart). An
// absent or malformed row normalizes to the defaults, so a hand-edited row can
// never half-apply. Environment overrides exist for the operator who has to
// react to a live incident without a settings round-trip: every overridden
// field keeps the name of the variable it came from, so the effective value is
// always attributable (env / stored / default) instead of silently different
// from what the panel shows.

import {
  LONG_TASK_CONTEXT_SETTINGS_KEY,
  isUsableLongTaskContextSettings,
  longTaskContextSettingsSchema,
  normalizeLongTaskContextSettings,
  type LongTaskContextSettingKey,
  type LongTaskContextSettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type LongTaskContextSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** The environment variable each field can be overridden with. */
export const LONG_TASK_CONTEXT_ENV_KEYS: Record<LongTaskContextSettingKey, string> = {
  enabled: "MYRMIDON_LONG_TASK_CONTEXT_ENABLED",
  resetPct: "MYRMIDON_LONG_TASK_CONTEXT_RESET_PCT",
  fallbackWindowTokens: "MYRMIDON_LONG_TASK_CONTEXT_FALLBACK_WINDOW_TOKENS",
  historyChars: "MYRMIDON_LONG_TASK_CONTEXT_HISTORY_CHARS",
};

export type LongTaskContextSettingSource = "env" | "stored" | "default";

export interface ResolvedLongTaskContextSettings {
  settings: LongTaskContextSettings;
  /** Where each effective field came from. */
  sources: Record<LongTaskContextSettingKey, LongTaskContextSettingSource>;
  /** field -> the environment variable that overrode it. */
  envKeys: Partial<Record<LongTaskContextSettingKey, string>>;
}

function parseEnvValue(key: LongTaskContextSettingKey, raw: string | undefined): unknown {
  const value = raw?.trim();
  if (!value) return undefined;
  if (key === "enabled") {
    if (/^(1|true|yes|on)$/i.test(value)) return true;
    if (/^(0|false|no|off)$/i.test(value)) return false;
    return undefined;
  }
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/**
 * The effective settings of one process: the stored row, with every field the
 * environment overrides (and only those) replaced. An override that does not
 * satisfy the field's own schema is ignored — an unparseable variable never
 * widens or breaks the guard.
 */
export function resolveLongTaskContextSettings(input: {
  stored: unknown;
  env?: NodeJS.ProcessEnv;
}): ResolvedLongTaskContextSettings {
  const env = input.env ?? {};
  const usableStored = isUsableLongTaskContextSettings(input.stored);
  const settings = normalizeLongTaskContextSettings(input.stored);
  const sources = {} as Record<LongTaskContextSettingKey, LongTaskContextSettingSource>;
  const envKeys: Partial<Record<LongTaskContextSettingKey, string>> = {};

  for (const key of Object.keys(LONG_TASK_CONTEXT_ENV_KEYS) as LongTaskContextSettingKey[]) {
    const envKey = LONG_TASK_CONTEXT_ENV_KEYS[key];
    const parsed = parseEnvValue(key, env[envKey]);
    const field = parsed === undefined
      ? null
      : longTaskContextSettingsSchema.shape[key].safeParse(parsed);
    if (field?.success) {
      (settings[key] as unknown) = field.data;
      sources[key] = "env";
      envKeys[key] = envKey;
      continue;
    }
    sources[key] = usableStored ? "stored" : "default";
  }

  return { settings, sources, envKeys };
}

/** Read the settings (or the defaults when absent). */
export async function readLongTaskContextSettings(
  settings: LongTaskContextSettingsService,
): Promise<LongTaskContextSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizeLongTaskContextSettings(general[LONG_TASK_CONTEXT_SETTINGS_KEY]);
}

/** Validate and store the full settings object (PUT semantics). */
export async function writeLongTaskContextSettings(
  settings: LongTaskContextSettingsService,
  input: LongTaskContextSettings,
): Promise<LongTaskContextSettings> {
  const parsed = longTaskContextSettingsSchema.parse(input);
  await settings.updateGeneral({ [LONG_TASK_CONTEXT_SETTINGS_KEY]: parsed });
  return parsed;
}