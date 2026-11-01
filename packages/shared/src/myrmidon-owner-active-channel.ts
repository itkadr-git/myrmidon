import { z } from "zod";

/**
 * Owner active channel (myrmidon 1.7-ACTIVE-CHANNEL).
 *
 * The owner talks to the board through two channels: the portal (web session)
 * and the Telegram DM bridge. Reports and plan answers must arrive where the
 * owner actually is, so the board marks the last activity of every owner per
 * channel (a portal request touches `web`, an inbound Telegram message
 * touches `telegram`) and resolves which channel is active right now.
 *
 * The inactivity threshold is one number: a channel counts as active while
 * its last touch is younger than the threshold. It lives in
 * `instance_settings.general.ownerActiveChannel`, is changed from the
 * instance settings screen without a restart, and the environment variable
 * stays a forced override only.
 *
 * Precedence per field: the environment variable (`MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN`),
 * then the stored settings value, then the built-in default. Sources are
 * reported with every read so the screen can show where a value came from.
 */

/** Owner channel ids; matches the bridge's `ConversationChannel` vocabulary. */
export const OWNER_CHANNELS = ["web", "telegram"] as const;
export type OwnerChannel = (typeof OWNER_CHANNELS)[number];

/** Forced override of the inactivity threshold, minutes. */
export const OWNER_ACTIVE_THRESHOLD_ENV = "MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN";

/** The stored key inside `instance_settings.general`. */
export const OWNER_ACTIVE_CHANNEL_SETTINGS_KEY = "ownerActiveChannel";

export const DEFAULT_OWNER_ACTIVE_THRESHOLD_MIN = 120;
export const MIN_OWNER_ACTIVE_THRESHOLD_MIN = 5;
export const MAX_OWNER_ACTIVE_THRESHOLD_MIN = 10080;

const thresholdMinSchema = z
  .number()
  .int()
  .min(MIN_OWNER_ACTIVE_THRESHOLD_MIN)
  .max(MAX_OWNER_ACTIVE_THRESHOLD_MIN);

/** The canonical stored shape of `general.ownerActiveChannel`. */
export const ownerActiveChannelSettingsSchema = z
  .object({
    thresholdMin: thresholdMinSchema.optional(),
  })
  .strict();

export type OwnerActiveChannelSettings = z.infer<typeof ownerActiveChannelSettingsSchema>;

/** Body of `PATCH /api/myrmidon/owner/active-channel`. */
export const patchOwnerActiveChannelSchema = z
  .object({
    thresholdMin: thresholdMinSchema.optional(),
  })
  .strict();

export type OwnerActiveChannelPatch = z.infer<typeof patchOwnerActiveChannelSchema>;

/** Where an effective value came from. */
export type OwnerActiveChannelSource = "settings" | "env" | "default";

export interface ResolvedOwnerActiveChannelSettings {
  thresholdMin: number;
  thresholdSource: OwnerActiveChannelSource;
}

/**
 * An environment threshold in minutes, clamped into the allowed bounds; a
 * blank or non-integer value reads as unset (null).
 */
export function parseOwnerActiveThresholdMin(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return Math.min(
    MAX_OWNER_ACTIVE_THRESHOLD_MIN,
    Math.max(MIN_OWNER_ACTIVE_THRESHOLD_MIN, parsed),
  );
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeOwnerActiveChannelSettings(
  raw: unknown,
): OwnerActiveChannelSettings | null {
  const parsed = ownerActiveChannelSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Merge a PATCH into the stored value; absent keys keep their stored value. */
export function mergeOwnerActiveChannelSettings(
  stored: unknown,
  patch: OwnerActiveChannelPatch,
): OwnerActiveChannelSettings {
  const current = normalizeOwnerActiveChannelSettings(stored) ?? {};
  return {
    ...current,
    ...(patch.thresholdMin !== undefined ? { thresholdMin: patch.thresholdMin } : {}),
  };
}

/** Effective settings and where each value came from. */
export function resolveOwnerActiveChannelSettings(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedOwnerActiveChannelSettings {
  const env = options.env ?? {};
  const stored = normalizeOwnerActiveChannelSettings(options.stored);

  const envThreshold = parseOwnerActiveThresholdMin(env[OWNER_ACTIVE_THRESHOLD_ENV]);
  if (envThreshold !== null) {
    return { thresholdMin: envThreshold, thresholdSource: "env" };
  }
  if (stored?.thresholdMin !== undefined) {
    return { thresholdMin: stored.thresholdMin, thresholdSource: "settings" };
  }
  return {
    thresholdMin: DEFAULT_OWNER_ACTIVE_THRESHOLD_MIN,
    thresholdSource: "default",
  };
}

/**
 * The channel the owner is active in: the freshest touch that is still
 * younger than the threshold. `web` wins a tie (the portal is the board's
 * own surface). `null` means neither channel is recent enough — callers keep
 * the standing delivery rules (the Telegram owner binding stays the fallback
 * for questions and confirmations; everything else stays board-only).
 */
export function resolveActiveOwnerChannel(
  lastActiveAt: Partial<Record<OwnerChannel, string | null | undefined>>,
  options: { thresholdMin: number; now?: number },
): OwnerChannel | null {
  const now = options.now ?? Date.now();
  let best: { channel: OwnerChannel; at: number } | null = null;
  for (const channel of OWNER_CHANNELS) {
    const raw = lastActiveAt[channel];
    if (!raw) continue;
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) continue;
    if (now - at > options.thresholdMin * 60_000) continue;
    if (best === null || at > best.at) best = { channel, at };
  }
  return best?.channel ?? null;
}

/** Response of `GET /api/myrmidon/owner/active-channel`. */
export interface OwnerActiveChannelView {
  channel: OwnerChannel | null;
  lastActiveAt: Record<OwnerChannel, string | null>;
  thresholdMin: number;
  thresholdSource: OwnerActiveChannelSource;
}
