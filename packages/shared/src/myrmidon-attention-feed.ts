import { z } from "zod";

/**
 * Attention feed windows (myrmidon 1.6.6 SETTINGS-UI, part C-4).
 *
 * The attention feed answers in one request, so two sizes of it are operator
 * values: how far back an unresolved failed/timed-out run may enter the feed,
 * and how long the built feed snapshot may be reused per company. Both live in
 * `instance_settings.general` as two flat keys —
 * `attentionFailedRunHorizonDays` (1–365 days, default 7) and
 * `attentionFeedCacheTtlSeconds` (0–300 s, default 45; `0` turns the cache
 * off). `server/src/services/attention.ts` reads them and applies them on the
 * next feed build; nothing is read at startup, so a PATCH needs no restart.
 *
 * This module is the single definition of those two values — bounds, defaults,
 * the stored shape and the body of the settings route — so the feed, the API
 * route and the settings screen cannot drift apart. There is no environment
 * variable for either value: the stored row wins, otherwise the built-in
 * default. A hand-edited row holding a non-integer or an out-of-bounds value
 * reads as the default, the same fallback the feed applies to itself.
 */

/** The two stored value names, as they appear in `instance_settings.general`. */
export const ATTENTION_FEED_STORED_KEYS = {
  failedRunHorizonDays: "attentionFailedRunHorizonDays",
  feedCacheTtlSeconds: "attentionFeedCacheTtlSeconds",
} as const;

export const ATTENTION_FEED_LIMIT_KEYS = ["failedRunHorizonDays", "feedCacheTtlSeconds"] as const;

export type AttentionFeedLimitKey = (typeof ATTENTION_FEED_LIMIT_KEYS)[number];

/** Where an effective window came from: the stored settings row or the default. */
export type AttentionFeedLimitSource = "settings" | "default";

/** Default horizon of the failed-run window: a run older than a week drops out. */
export const ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS = 7;
export const ATTENTION_FAILED_RUN_HORIZON_MIN_DAYS = 1;
export const ATTENTION_FAILED_RUN_HORIZON_MAX_DAYS = 365;

/** Default TTL of the per-company feed snapshot: 45 s. */
export const ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS = 45;
export const ATTENTION_FEED_CACHE_TTL_MIN_SECONDS = 0;
export const ATTENTION_FEED_CACHE_TTL_MAX_SECONDS = 300;

/** Action of a window change, written for every company like every instance settings write. */
export const ATTENTION_FEED_UPDATED_ACTION = "instance.attention_feed.updated";

const horizonDaysSchema = z
  .number()
  .int()
  .min(ATTENTION_FAILED_RUN_HORIZON_MIN_DAYS)
  .max(ATTENTION_FAILED_RUN_HORIZON_MAX_DAYS);

const cacheTtlSecondsSchema = z
  .number()
  .int()
  .min(ATTENTION_FEED_CACHE_TTL_MIN_SECONDS)
  .max(ATTENTION_FEED_CACHE_TTL_MAX_SECONDS);

/** The canonical value shape, same bounds as the two validators in validators/instance.ts. */
export const attentionFeedSettingsSchema = z
  .object({
    failedRunHorizonDays: horizonDaysSchema,
    feedCacheTtlSeconds: cacheTtlSecondsSchema,
  })
  .strict();

/** Body of `PATCH /api/myrmidon/attention-feed`. */
export const patchAttentionFeedSettingsSchema = z
  .object({
    failedRunHorizonDays: horizonDaysSchema.optional(),
    feedCacheTtlSeconds: cacheTtlSecondsSchema.optional(),
  })
  .strict();

export type AttentionFeedSettings = z.infer<typeof attentionFeedSettingsSchema>;
export type AttentionFeedSettingsPatch = z.infer<typeof patchAttentionFeedSettingsSchema>;

/** Bounds and defaults, as the settings screen renders them. */
export interface AttentionFeedBounds {
  failedRunHorizonDays: { min: number; max: number; default: number };
  feedCacheTtlSeconds: { min: number; max: number; default: number };
}

export const ATTENTION_FEED_BOUNDS: AttentionFeedBounds = {
  failedRunHorizonDays: {
    min: ATTENTION_FAILED_RUN_HORIZON_MIN_DAYS,
    max: ATTENTION_FAILED_RUN_HORIZON_MAX_DAYS,
    default: ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS,
  },
  feedCacheTtlSeconds: {
    min: ATTENTION_FEED_CACHE_TTL_MIN_SECONDS,
    max: ATTENTION_FEED_CACHE_TTL_MAX_SECONDS,
    default: ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
  },
};

export const DEFAULT_ATTENTION_FEED_SETTINGS: AttentionFeedSettings = {
  failedRunHorizonDays: ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS,
  feedCacheTtlSeconds: ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
};

export interface ResolvedAttentionFeedSettings {
  settings: AttentionFeedSettings;
  sources: Record<AttentionFeedLimitKey, AttentionFeedLimitSource>;
}

/** The flat, canonical `instance_settings.general` keys holding the two windows. */
export interface AttentionFeedStoredValues {
  attentionFailedRunHorizonDays: number;
  attentionFeedCacheTtlSeconds: number;
}

/** The subset of those keys a single PATCH rewrites. */
export type AttentionFeedStoredPatch = Partial<AttentionFeedStoredValues>;

/**
 * The general-settings block as this module reads it: two flat, optional keys
 * whose stored value is not trusted until it validates. Anything else in the
 * block is none of its business.
 */
export interface StoredAttentionFeedSettings {
  attentionFailedRunHorizonDays?: unknown;
  attentionFeedCacheTtlSeconds?: unknown;
}

/** One stored value as an in-bounds integer, or null when unusable. */
function normalizeValue(raw: unknown, key: AttentionFeedLimitKey): number | null {
  const schema = key === "failedRunHorizonDays" ? horizonDaysSchema : cacheTtlSecondsSchema;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective windows and where each came from (see the module comment). A key
 * that is absent, of the wrong type or out of bounds reads as the default —
 * never as a half-applied pair.
 */
export function resolveAttentionFeedSettings(
  stored: StoredAttentionFeedSettings | null | undefined = {},
): ResolvedAttentionFeedSettings {
  const row = stored ?? {};
  const horizon = normalizeValue(row.attentionFailedRunHorizonDays, "failedRunHorizonDays");
  const cacheTtl = normalizeValue(row.attentionFeedCacheTtlSeconds, "feedCacheTtlSeconds");
  return {
    settings: {
      failedRunHorizonDays: horizon ?? ATTENTION_FAILED_RUN_HORIZON_DEFAULT_DAYS,
      feedCacheTtlSeconds: cacheTtl ?? ATTENTION_FEED_CACHE_TTL_DEFAULT_SECONDS,
    },
    sources: {
      failedRunHorizonDays: horizon === null ? "default" : "settings",
      feedCacheTtlSeconds: cacheTtl === null ? "default" : "settings",
    },
  };
}

/** A patch over the effective values, in the flat shape that gets stored. */
export function mergeAttentionFeedSettings(
  base: AttentionFeedSettings,
  patch: AttentionFeedSettingsPatch,
): AttentionFeedSettings {
  return {
    failedRunHorizonDays:
      patch.failedRunHorizonDays === undefined
        ? base.failedRunHorizonDays
        : patch.failedRunHorizonDays,
    feedCacheTtlSeconds:
      patch.feedCacheTtlSeconds === undefined ? base.feedCacheTtlSeconds : patch.feedCacheTtlSeconds,
  };
}

/** The flat `instance_settings.general` patch for a resolved value pair. */
export function attentionFeedStoredPatch(
  settings: AttentionFeedSettings,
  patch: AttentionFeedSettingsPatch,
): AttentionFeedStoredPatch {
  const stored: AttentionFeedStoredPatch = {};
  if (patch.failedRunHorizonDays !== undefined) {
    stored.attentionFailedRunHorizonDays = settings.failedRunHorizonDays;
  }
  if (patch.feedCacheTtlSeconds !== undefined) {
    stored.attentionFeedCacheTtlSeconds = settings.feedCacheTtlSeconds;
  }
  return stored;
}