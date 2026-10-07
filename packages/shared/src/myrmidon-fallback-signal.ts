import { z } from "zod";

/**
 * Settings contract of the model fallback signal (myrmidon BOT-RUNTIME-TUNING D).
 *
 * The signal itself — "this bot's gateway calls were served by a model outside
 * its card more than N% of the window" — is computed by
 * `server/src/myrmidon/litellm-fallback-signal/`. This module owns the values
 * that decide when it fires, so the server, the settings API and the agent card
 * read one set of numbers.
 *
 * Precedence, per key (the same contract `swarmClaim` and `wipLimit` follow):
 *
 * - the stored setting (`instance_settings.general.modelFallbackSignal`, edited
 *   through `GET/PATCH /api/myrmidon/model-fallback/settings`), when the stored
 *   object parses;
 * - otherwise the environment variable of that key (the deployment default an
 *   operator can still force without touching the database);
 * - otherwise the built-in default.
 *
 * `resolveFallbackSignalSettings` reports the source of every key, so a caller
 * can say where an effective threshold came from instead of guessing.
 *
 * The environment reader reproduces the semantics of the deployments that set
 * the variables before this contract existed: an unreadable value falls back to
 * the default, while a readable but out-of-range number is clamped into range
 * (a threshold of `0` means "the lowest threshold there is", not "unset").
 */

/**
 * Stored-settings key inside `instance_settings.general`. One key holds the
 * whole object, like `swarmClaim` and `runLimits`, so a partial hand-edit
 * cannot silently arm the sweep.
 */
export const FALLBACK_SIGNAL_SETTINGS_KEY = "modelFallbackSignal";

/**
 * Environment variable per setting. Before this contract these variables were
 * the only source; they keep working as a per-key override.
 */
export const FALLBACK_SIGNAL_ENV_KEYS = {
  enabled: "MYRMIDON_MODEL_FALLBACK_ENABLED",
  thresholdPct: "MYRMIDON_MODEL_FALLBACK_THRESHOLD_PCT",
  minCalls: "MYRMIDON_MODEL_FALLBACK_MIN_CALLS",
  windowSec: "MYRMIDON_MODEL_FALLBACK_WINDOW_SEC",
  intervalSec: "MYRMIDON_MODEL_FALLBACK_INTERVAL_SEC",
} as const;

export const FALLBACK_SIGNAL_SETTING_KEYS = [
  "enabled",
  "thresholdPct",
  "minCalls",
  "windowSec",
  "intervalSec",
] as const;

export type FallbackSignalSettingKey = (typeof FALLBACK_SIGNAL_SETTING_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type FallbackSignalSettingSource = "settings" | "env" | "default";

/**
 * Master switch. Off by default: the sweep is a notice, and a notice that
 * starts itself on a fresh instance is noise.
 */
export const DEFAULT_FALLBACK_SIGNAL_ENABLED = false;

/** Fallback share (percent of attributed calls in the window) that raises the card. */
export const MIN_FALLBACK_SIGNAL_THRESHOLD_PCT = 1;
export const MAX_FALLBACK_SIGNAL_THRESHOLD_PCT = 100;
export const DEFAULT_FALLBACK_SIGNAL_THRESHOLD_PCT = 20;

/** Attributed calls needed in the window before an agent is evaluated at all. */
export const MIN_FALLBACK_SIGNAL_MIN_CALLS = 1;
export const DEFAULT_FALLBACK_SIGNAL_MIN_CALLS = 20;

/** Length of the rolling window the share is computed over. */
export const MIN_FALLBACK_SIGNAL_WINDOW_SEC = 300;
export const MAX_FALLBACK_SIGNAL_WINDOW_SEC = 86_400;
export const DEFAULT_FALLBACK_SIGNAL_WINDOW_SEC = 3_600;

/** Sweep period. A change applies on the next scheduled tick, without a restart. */
export const MIN_FALLBACK_SIGNAL_INTERVAL_SEC = 60;
export const MAX_FALLBACK_SIGNAL_INTERVAL_SEC = 86_400;
export const DEFAULT_FALLBACK_SIGNAL_INTERVAL_SEC = 300;

const thresholdSchema = z
  .number()
  .int()
  .min(MIN_FALLBACK_SIGNAL_THRESHOLD_PCT)
  .max(MAX_FALLBACK_SIGNAL_THRESHOLD_PCT);
const minCallsSchema = z.number().int().min(MIN_FALLBACK_SIGNAL_MIN_CALLS);
const windowSchema = z
  .number()
  .int()
  .min(MIN_FALLBACK_SIGNAL_WINDOW_SEC)
  .max(MAX_FALLBACK_SIGNAL_WINDOW_SEC);
const intervalSchema = z
  .number()
  .int()
  .min(MIN_FALLBACK_SIGNAL_INTERVAL_SEC)
  .max(MAX_FALLBACK_SIGNAL_INTERVAL_SEC);

/** The canonical stored shape of `instance_settings.general.modelFallbackSignal`. */
export const fallbackSignalSettingsSchema = z
  .object({
    enabled: z.boolean(),
    thresholdPct: thresholdSchema,
    minCalls: minCallsSchema,
    windowSec: windowSchema,
    intervalSec: intervalSchema,
  })
  .strict();

/** Body of `PATCH /api/myrmidon/model-fallback/settings`: any subset; absent keys keep their value. */
export const patchFallbackSignalSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdPct: thresholdSchema.optional(),
    minCalls: minCallsSchema.optional(),
    windowSec: windowSchema.optional(),
    intervalSec: intervalSchema.optional(),
  })
  .strict();

/**
 * What a stored row may hold: the canonical shape with every key optional, so a
 * row saved before a key existed still parses and the missing key resolves from
 * the environment or the default. `.strict()` keeps a typo out of the row
 * instead of silently ignoring it. This is the shape registered in
 * `packages/shared/src/validators/instance.ts`, so a vendor write keeps the key.
 */
export const storedFallbackSignalSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdPct: thresholdSchema.optional(),
    minCalls: minCallsSchema.optional(),
    windowSec: windowSchema.optional(),
    intervalSec: intervalSchema.optional(),
  })
  .strict();

export type FallbackSignalSettings = z.infer<typeof fallbackSignalSettingsSchema>;
export type FallbackSignalSettingsPatch = z.infer<typeof patchFallbackSignalSettingsSchema>;
export type StoredFallbackSignalSettings = z.infer<typeof storedFallbackSignalSettingsSchema>;

export interface ResolvedFallbackSignalSettings {
  settings: FallbackSignalSettings;
  /** Per key: which side won. */
  sources: Record<FallbackSignalSettingKey, FallbackSignalSettingSource>;
}

/** The single truth for "is this string an explicit on?"; a typo never arms the sweep. */
export function parseFallbackSignalEnabled(raw: string | undefined | null): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

function numberEnv(
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max?: number },
): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value)) return fallback;
  const upper = bounds.max ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(value, bounds.min), upper);
}

/** The settings as the environment declares them, with the built-in defaults. */
export function readFallbackSignalSettingsFromEnv(
  env: Record<string, string | undefined> = {},
): FallbackSignalSettings {
  return {
    enabled: parseFallbackSignalEnabled(env[FALLBACK_SIGNAL_ENV_KEYS.enabled]) ?? DEFAULT_FALLBACK_SIGNAL_ENABLED,
    thresholdPct: numberEnv(env[FALLBACK_SIGNAL_ENV_KEYS.thresholdPct], DEFAULT_FALLBACK_SIGNAL_THRESHOLD_PCT, {
      min: MIN_FALLBACK_SIGNAL_THRESHOLD_PCT,
      max: MAX_FALLBACK_SIGNAL_THRESHOLD_PCT,
    }),
    minCalls: numberEnv(env[FALLBACK_SIGNAL_ENV_KEYS.minCalls], DEFAULT_FALLBACK_SIGNAL_MIN_CALLS, {
      min: MIN_FALLBACK_SIGNAL_MIN_CALLS,
    }),
    windowSec: numberEnv(env[FALLBACK_SIGNAL_ENV_KEYS.windowSec], DEFAULT_FALLBACK_SIGNAL_WINDOW_SEC, {
      min: MIN_FALLBACK_SIGNAL_WINDOW_SEC,
      max: MAX_FALLBACK_SIGNAL_WINDOW_SEC,
    }),
    intervalSec: numberEnv(env[FALLBACK_SIGNAL_ENV_KEYS.intervalSec], DEFAULT_FALLBACK_SIGNAL_INTERVAL_SEC, {
      min: MIN_FALLBACK_SIGNAL_INTERVAL_SEC,
      max: MAX_FALLBACK_SIGNAL_INTERVAL_SEC,
    }),
  };
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeFallbackSignalSettings(raw: unknown): FallbackSignalSettings | null {
  const parsed = fallbackSignalSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective settings and where each value came from. `stored` is the raw
 * `general.modelFallbackSignal` value; an unreadable one counts as absent, so
 * the environment (or the default) applies instead.
 *
 * A key whose environment variable is set and readable wins over the stored
 * value — the override an operator uses to force a contour. A key that is only
 * in the stored object comes from the settings, and a key neither side sets is
 * the built-in default.
 */
export function resolveFallbackSignalSettings(
  options: { stored?: unknown; env?: Record<string, string | undefined> } = {},
): ResolvedFallbackSignalSettings {
  const env = options.env ?? {};
  const stored = normalizeFallbackSignalSettings(options.stored);
  const base = stored ?? readFallbackSignalSettingsFromEnv({});
  const settings: FallbackSignalSettings = {
    enabled: parseFallbackSignalEnabled(env[FALLBACK_SIGNAL_ENV_KEYS.enabled]) ?? base.enabled,
    thresholdPct: numberEnv(env[FALLBACK_SIGNAL_ENV_KEYS.thresholdPct], base.thresholdPct, {
      min: MIN_FALLBACK_SIGNAL_THRESHOLD_PCT,
      max: MAX_FALLBACK_SIGNAL_THRESHOLD_PCT,
    }),
    minCalls: numberEnv(env[FALLBACK_SIGNAL_ENV_KEYS.minCalls], base.minCalls, {
      min: MIN_FALLBACK_SIGNAL_MIN_CALLS,
    }),
    windowSec: numberEnv(env[FALLBACK_SIGNAL_ENV_KEYS.windowSec], base.windowSec, {
      min: MIN_FALLBACK_SIGNAL_WINDOW_SEC,
      max: MAX_FALLBACK_SIGNAL_WINDOW_SEC,
    }),
    intervalSec: numberEnv(env[FALLBACK_SIGNAL_ENV_KEYS.intervalSec], base.intervalSec, {
      min: MIN_FALLBACK_SIGNAL_INTERVAL_SEC,
      max: MAX_FALLBACK_SIGNAL_INTERVAL_SEC,
    }),
  };

  const hasOverride = (name: string) => {
    const raw = env[name];
    return raw !== undefined && raw.trim() !== "";
  };
  const sources = {} as Record<FallbackSignalSettingKey, FallbackSignalSettingSource>;
  for (const key of FALLBACK_SIGNAL_SETTING_KEYS) {
    sources[key] = hasOverride(FALLBACK_SIGNAL_ENV_KEYS[key]) ? "env" : stored ? "settings" : "default";
  }
  return { settings, sources };
}

/** A patch over the effective values, the shape that gets stored. */
export function mergeFallbackSignalSettings(
  base: FallbackSignalSettings,
  patch: FallbackSignalSettingsPatch,
): FallbackSignalSettings {
  return {
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    thresholdPct: patch.thresholdPct === undefined ? base.thresholdPct : patch.thresholdPct,
    minCalls: patch.minCalls === undefined ? base.minCalls : patch.minCalls,
    windowSec: patch.windowSec === undefined ? base.windowSec : patch.windowSec,
    intervalSec: patch.intervalSec === undefined ? base.intervalSec : patch.intervalSec,
  };
}

/** The window in milliseconds — the unit the sweep works in. */
export function fallbackSignalWindowMs(settings: Pick<FallbackSignalSettings, "windowSec">): number {
  return settings.windowSec * 1000;
}

/** The sweep period in milliseconds. */
export function fallbackSignalIntervalMs(
  settings: Pick<FallbackSignalSettings, "intervalSec">,
): number {
  return settings.intervalSec * 1000;
}