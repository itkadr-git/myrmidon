// server/src/myrmidon/litellm-fallback-signal/settings.ts
//
// myrmidon(BOT-RUNTIME-TUNING D2): the database half of the fallback-signal
// settings — read and write `instance_settings.general.modelFallbackSignal`.
//
// Until now the sweep's numbers came from `MYRMIDON_MODEL_FALLBACK_*` only and
// were read once when the timer was armed, so changing the threshold or the
// window meant restarting the board. This module follows the precedence decided
// in `@paperclipai/shared` (stored settings, then a set environment variable,
// then the built-in default) and is read on every sweep tick and on every
// request, so an operator changes the signal from the settings API and the next
// tick obeys — no restart.
//
// Every write is whole-object: the patch is merged over the effective values
// and the canonical object is stored under one key, so a partial hand-edit of
// `general` cannot arm or disarm the signal by accident.

import {
  FALLBACK_SIGNAL_SETTINGS_KEY,
  mergeFallbackSignalSettings,
  patchFallbackSignalSettingsSchema,
  resolveFallbackSignalSettings,
  type FallbackSignalSettingsPatch,
  type ResolvedFallbackSignalSettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type FallbackSignalSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

type GeneralRecord = Record<string, unknown>;

function asGeneral(value: unknown): GeneralRecord {
  return typeof value === "object" && value !== null ? (value as GeneralRecord) : {};
}

/** The raw stored object, or undefined when the row holds nothing. */
export async function readStoredFallbackSignalSettings(
  settings: FallbackSignalSettingsService,
): Promise<unknown> {
  const general = asGeneral(await settings.getGeneral());
  return general[FALLBACK_SIGNAL_SETTINGS_KEY];
}

/**
 * The effective settings and the source of every key. Called per sweep tick and
 * per request, never cached — that is what makes a change apply without a
 * restart.
 */
export async function readResolvedFallbackSignalSettings(
  settings: FallbackSignalSettingsService,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedFallbackSignalSettings> {
  return resolveFallbackSignalSettings({
    stored: await readStoredFallbackSignalSettings(settings),
    env,
  });
}

/**
 * Merge a patch over the effective values and store the result. Returns the
 * settings as they resolve after the write: a key whose environment variable is
 * set keeps reporting `env` even though the stored object now carries a value,
 * which is exactly the precedence an operator sees on the board.
 */
export async function updateFallbackSignalSettings(
  settings: FallbackSignalSettingsService,
  patch: FallbackSignalSettingsPatch,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedFallbackSignalSettings> {
  const parsed = patchFallbackSignalSettingsSchema.parse(patch);
  const current = await readResolvedFallbackSignalSettings(settings, env);
  const next = mergeFallbackSignalSettings(current.settings, parsed);
  await settings.updateGeneral({ [FALLBACK_SIGNAL_SETTINGS_KEY]: next });
  return readResolvedFallbackSignalSettings(settings, env);
}

/**
 * Keep the stored key across vendor writes of `instance_settings.general` —
 * the same contract every other myrmidon general key follows.
 */
export function preserveFallbackSignalGeneralKey(storedGeneral: unknown): GeneralRecord {
  const general = asGeneral(storedGeneral);
  const value = general[FALLBACK_SIGNAL_SETTINGS_KEY];
  return value === undefined ? {} : { [FALLBACK_SIGNAL_SETTINGS_KEY]: value };
}