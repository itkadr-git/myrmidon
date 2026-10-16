// server/src/myrmidon/bridge-language/settings.ts
//
// myrmidon(1.6.5-TG-LOCALE-C): where the instance-wide default language of the
// bridged Telegram DM lives and how it survives every vendor write of
// `instance_settings.general`.
//
// The value is read while answering a bridged message, so the stored row is
// reused for a few seconds at most; a PATCH drops the cached value at once.
// The precedence (environment force, then the stored instance value, then
// English) is decided in `@paperclipai/shared` (myrmidon-bridge-language.ts).
//
// This file deliberately has no runtime import of the instance settings
// service: services/instance-settings.ts imports the preserve helper below.

import {
  BRIDGE_LANGUAGE_SETTINGS_KEY,
  resolveBridgeLanguage,
  type ResolvedBridgeLanguage,
} from "@paperclipai/shared";

export { BRIDGE_LANGUAGE_SETTINGS_KEY };

/** How long the stored value is reused while answering bridged messages. */
export const BRIDGE_LANGUAGE_CACHE_MS = 5_000;

/** The deps the reader needs, so tests can run it without a database. */
export interface BridgeLanguageSettingsDeps {
  getGeneral(): Promise<unknown>;
  env?: Record<string, string | undefined>;
  now?: () => number;
  cacheMs?: number;
}

// Only the stored row value is cached, never the resolved language: the
// environment force is re-read on every call, so changing it applies at once.
let cached: { at: number; stored: unknown } | null = null;

/** Drop the cached stored value (after a settings change, and in tests). */
export function invalidateBridgeLanguageSettingsCache(): void {
  cached = null;
}

async function readStored(deps: BridgeLanguageSettingsDeps): Promise<unknown> {
  const now = deps.now ? deps.now() : Date.now();
  const cacheMs = deps.cacheMs ?? BRIDGE_LANGUAGE_CACHE_MS;
  if (cached && cacheMs > 0 && now >= cached.at && now - cached.at < cacheMs) {
    return cached.stored;
  }
  let stored: unknown;
  try {
    const general = await deps.getGeneral();
    stored =
      typeof general === "object" && general !== null
        ? (general as Record<string, unknown>)[BRIDGE_LANGUAGE_SETTINGS_KEY]
        : undefined;
  } catch {
    // A read failure is not cached: the next message tries again.
    return undefined;
  }
  cached = { at: now, stored };
  return stored;
}

/**
 * The instance-level bridge language in force right now. A settings read
 * failure falls back to the environment force and the default (never throws):
 * answering a message must not fail because the settings row is unavailable.
 */
export async function readBridgeLanguageSettings(
  deps: BridgeLanguageSettingsDeps,
): Promise<ResolvedBridgeLanguage> {
  const stored = await readStored(deps);
  return resolveBridgeLanguage({ stored, env: deps.env ?? process.env });
}

/** Keep the stored setting across every vendor general write. */
export function preserveBridgeLanguageGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[BRIDGE_LANGUAGE_SETTINGS_KEY];
  return value === undefined ? {} : { [BRIDGE_LANGUAGE_SETTINGS_KEY]: value };
}