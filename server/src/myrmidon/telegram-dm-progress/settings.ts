// server/src/myrmidon/telegram-dm-progress/settings.ts
//
// myrmidon(DM-PROGRESS): where the live-progress settings of the bridged
// Telegram DM status message live and how they survive every vendor write of
// `instance_settings.general`.
//
// The settings are read on every milestone sweep (the sweep runs about once a
// second), so the reader keeps the resolved value for a few seconds at most;
// a PATCH drops the cached value at once. The precedence (environment
// override, then stored settings, then the built-in default) is decided in
// `@paperclipai/shared` (myrmidon-telegram-dm-progress.ts).
//
// This file deliberately has no runtime import of the instance settings
// service: services/instance-settings.ts imports the preserve helper below.

import {
  TELEGRAM_DM_PROGRESS_SETTINGS_KEY,
  resolveTelegramDmProgress,
  type ResolvedTelegramDmProgress,
} from "@paperclipai/shared";

export { TELEGRAM_DM_PROGRESS_SETTINGS_KEY };

/** How long the stored settings value is reused by the sweep. */
export const TELEGRAM_DM_PROGRESS_CACHE_MS = 5_000;

/** The deps the reader needs, so tests can run it without a database. */
export interface TelegramDmProgressSettingsDeps {
  getGeneral(): Promise<unknown>;
  env?: Record<string, string | undefined>;
  now?: () => number;
  cacheMs?: number;
}

// Only the stored row value is cached, never the resolved settings: the
// environment overrides are re-read on every call, so changing them (or the
// status-message switch the default follows) applies on the next sweep.
let cached: { at: number; stored: unknown } | null = null;

/** Drop the cached stored value (after a settings change, and in tests). */
export function invalidateTelegramDmProgressSettingsCache(): void {
  cached = null;
}

async function readStored(deps: TelegramDmProgressSettingsDeps): Promise<unknown> {
  const now = deps.now ? deps.now() : Date.now();
  const cacheMs = deps.cacheMs ?? TELEGRAM_DM_PROGRESS_CACHE_MS;
  if (cached && cacheMs > 0 && now >= cached.at && now - cached.at < cacheMs) {
    return cached.stored;
  }
  let stored: unknown;
  try {
    const general = await deps.getGeneral();
    stored =
      typeof general === "object" && general !== null
        ? (general as Record<string, unknown>)[TELEGRAM_DM_PROGRESS_SETTINGS_KEY]
        : undefined;
  } catch {
    // A read failure is not cached: the next sweep tries again.
    return undefined;
  }
  cached = { at: now, stored };
  return stored;
}

/**
 * The live-progress settings in force right now. A settings read failure
 * falls back to the environment and the defaults (never throws): the status
 * message is a convenience and must not break the milestone sweep.
 */
export async function readTelegramDmProgressSettings(
  deps: TelegramDmProgressSettingsDeps,
): Promise<ResolvedTelegramDmProgress> {
  const stored = await readStored(deps);
  return resolveTelegramDmProgress({ stored, env: deps.env ?? process.env });
}

/** Keep the stored settings across every vendor general write. */
export function preserveTelegramDmProgressGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[TELEGRAM_DM_PROGRESS_SETTINGS_KEY];
  return value === undefined ? {} : { [TELEGRAM_DM_PROGRESS_SETTINGS_KEY]: value };
}
