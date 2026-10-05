// server/src/myrmidon/owner-active-channel/settings.ts
//
// myrmidon(1.7-ACTIVE-CHANNEL): where the owner active-channel settings live
// and how they survive every vendor write of `instance_settings.general`.
//
// The threshold is read on the delivery path (every card routed to the owner)
// and on the status route, so the reader keeps the stored value for a few
// seconds at most; a PATCH drops the cached value at once. The precedence
// (environment forced override, then stored settings, then the built-in
// default) is decided in `@paperclipai/shared`.
//
// Like the DM-PROGRESS module, this file has no runtime import of the
// instance settings service: services/instance-settings.ts imports the
// preserve helper below.

import {
  OWNER_ACTIVE_CHANNEL_SETTINGS_KEY,
  resolveOwnerActiveChannelSettings,
  type ResolvedOwnerActiveChannelSettings,
} from "@paperclipai/shared";

export { OWNER_ACTIVE_CHANNEL_SETTINGS_KEY };

/** How long the stored settings value is reused by readers. */
export const OWNER_ACTIVE_CHANNEL_CACHE_MS = 5_000;

export interface OwnerActiveChannelSettingsDeps {
  getGeneral(): Promise<unknown>;
  env?: Record<string, string | undefined>;
  now?: () => number;
  cacheMs?: number;
}

// Only the stored row value is cached; environment overrides are re-read on
// every call, so a forced env change applies without any cache expiry.
let cached: { at: number; stored: unknown } | null = null;

/** Drop the cached stored value (after a settings change, and in tests). */
export function invalidateOwnerActiveChannelSettingsCache(): void {
  cached = null;
}

async function readStored(deps: OwnerActiveChannelSettingsDeps): Promise<unknown> {
  const now = deps.now ? deps.now() : Date.now();
  const cacheMs = deps.cacheMs ?? OWNER_ACTIVE_CHANNEL_CACHE_MS;
  if (cached && cacheMs > 0 && now >= cached.at && now - cached.at < cacheMs) {
    return cached.stored;
  }
  let stored: unknown;
  try {
    const general = await deps.getGeneral();
    stored =
      typeof general === "object" && general !== null
        ? (general as Record<string, unknown>)[OWNER_ACTIVE_CHANNEL_SETTINGS_KEY]
        : undefined;
  } catch {
    // A read failure is not cached: the next reader tries again.
    return undefined;
  }
  cached = { at: now, stored };
  return stored;
}

/**
 * The active-channel settings in force right now. A settings read failure
 * falls back to the environment and the defaults (never throws): an owner
 * routing decision must not break a delivery on a settings row read.
 */
export async function readOwnerActiveChannelSettings(
  deps: OwnerActiveChannelSettingsDeps,
): Promise<ResolvedOwnerActiveChannelSettings> {
  const stored = await readStored(deps);
  return resolveOwnerActiveChannelSettings({ stored, env: deps.env ?? process.env });
}

/** Keep the stored settings across every vendor general write. */
export function preserveOwnerActiveChannelGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[OWNER_ACTIVE_CHANNEL_SETTINGS_KEY];
  return value === undefined ? {} : { [OWNER_ACTIVE_CHANNEL_SETTINGS_KEY]: value };
}
