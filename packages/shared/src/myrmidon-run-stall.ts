import { z } from "zod";

/**
 * Run stall detection settings that can be changed while the server runs
 * (myrmidon 1.6.5 RUN-STALL-SETTINGS, OPE-5087).
 *
 * The values drive the progress-based run liveness sweep
 * (server/src/myrmidon/run-stall): whether it runs at all, how long a running
 * run may go without recorded progress before it is interrupted as
 * `run_stalled`, the minimum spacing between two scan passes, and how many
 * runs one pass inspects. In the deployment they come from the environment
 * (`MYRMIDON_RUN_STALL_*`); this module also stores them in
 * `instance_settings.general.runStall` so an operator can change them from
 * the API and the settings page without restarting the server — a restart
 * drops every run in flight.
 *
 * Precedence, per value, is decided here once and read from two places:
 *
 * - the stored settings value, when the key is present in `general.runStall`;
 * - otherwise the environment variable, which stays the default for an
 *   instance that has never saved these settings;
 * - otherwise the built-in default: on, a 20-minute threshold, a 60-second
 *   check interval, a page of 50 runs.
 *
 * The environment reader deliberately keeps the reader semantics of
 * server/src/myrmidon/run-stall/settings.ts: `enabled` is on unless the
 * variable is an explicit off word (a typo must not silently extinguish the
 * fix — the feature is a defect fix, CONVENTIONS.md §8), and an unset or
 * unreadable number is the built-in default. The stored object, by contrast,
 * is canonical: `PATCH /api/myrmidon/run-stall` validates strictly (a number
 * must be a whole integer inside the documented range), so a hand-edited row
 * can only hold values the server itself once accepted.
 */

export const RUN_STALL_ENABLED_ENV = "MYRMIDON_RUN_STALL_ENABLED";
export const RUN_STALL_THRESHOLD_SEC_ENV = "MYRMIDON_RUN_STALL_THRESHOLD_SEC";
export const RUN_STALL_CHECK_INTERVAL_SEC_ENV = "MYRMIDON_RUN_STALL_CHECK_INTERVAL_SEC";
export const RUN_STALL_PAGE_SIZE_ENV = "MYRMIDON_RUN_STALL_PAGE_SIZE";

export const RUN_STALL_ENV_KEYS = {
  enabled: RUN_STALL_ENABLED_ENV,
  thresholdSec: RUN_STALL_THRESHOLD_SEC_ENV,
  checkIntervalSec: RUN_STALL_CHECK_INTERVAL_SEC_ENV,
  pageSize: RUN_STALL_PAGE_SIZE_ENV,
} as const;

export const RUN_STALL_KEYS = ["enabled", "thresholdSec", "checkIntervalSec", "pageSize"] as const;

export type RunStallKey = (typeof RUN_STALL_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type RunStallSource = "settings" | "env" | "default";

/** The defaults mirror server/src/myrmidon/run-stall/settings.ts. */
export const DEFAULT_RUN_STALL_THRESHOLD_SEC = 20 * 60;
export const MIN_RUN_STALL_THRESHOLD_SEC = 60;
export const MAX_RUN_STALL_THRESHOLD_SEC = 24 * 60 * 60;

export const DEFAULT_RUN_STALL_CHECK_INTERVAL_SEC = 60;
export const MIN_RUN_STALL_CHECK_INTERVAL_SEC = 15;
export const MAX_RUN_STALL_CHECK_INTERVAL_SEC = 24 * 60 * 60;

export const DEFAULT_RUN_STALL_PAGE_SIZE = 50;
export const MIN_RUN_STALL_PAGE_SIZE = 1;
export const MAX_RUN_STALL_PAGE_SIZE = 200;

/** The canonical stored shape of `instance_settings.general.runStall`. */
export const runStallSettingsSchema = z
  .object({
    enabled: z.boolean(),
    thresholdSec: z.number().int().min(MIN_RUN_STALL_THRESHOLD_SEC).max(MAX_RUN_STALL_THRESHOLD_SEC),
    checkIntervalSec: z
      .number()
      .int()
      .min(MIN_RUN_STALL_CHECK_INTERVAL_SEC)
      .max(MAX_RUN_STALL_CHECK_INTERVAL_SEC),
    pageSize: z.number().int().min(MIN_RUN_STALL_PAGE_SIZE).max(MAX_RUN_STALL_PAGE_SIZE),
  })
  .strict();

/**
 * Body of `PATCH /api/myrmidon/run-stall`: any subset of the values. Absent
 * keys keep their effective value.
 */
export const patchRunStallSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdSec: z.number().int().min(MIN_RUN_STALL_THRESHOLD_SEC).max(MAX_RUN_STALL_THRESHOLD_SEC).optional(),
    checkIntervalSec: z
      .number()
      .int()
      .min(MIN_RUN_STALL_CHECK_INTERVAL_SEC)
      .max(MAX_RUN_STALL_CHECK_INTERVAL_SEC)
      .optional(),
    pageSize: z.number().int().min(MIN_RUN_STALL_PAGE_SIZE).max(MAX_RUN_STALL_PAGE_SIZE).optional(),
  })
  .strict();

export type RunStallValues = z.infer<typeof runStallSettingsSchema>;
export type RunStallPatch = z.infer<typeof patchRunStallSchema>;

export interface ResolvedRunStall {
  settings: RunStallValues;
  sources: Record<RunStallKey, RunStallSource>;
}

const RUN_STALL_OFF_WORDS = ["0", "off", "false", "no"];

function readEnvEnabled(raw: string | undefined): boolean {
  const trimmed = raw?.trim().toLowerCase();
  return !trimmed || !RUN_STALL_OFF_WORDS.includes(trimmed);
}

function readEnvInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

/** The settings as the environment declares them, with the built-in defaults. */
export function readRunStallFromEnv(env: Record<string, string | undefined> = {}): RunStallValues {
  return {
    enabled: readEnvEnabled(env[RUN_STALL_ENABLED_ENV]),
    thresholdSec: readEnvInt(
      env,
      RUN_STALL_THRESHOLD_SEC_ENV,
      DEFAULT_RUN_STALL_THRESHOLD_SEC,
      MIN_RUN_STALL_THRESHOLD_SEC,
      MAX_RUN_STALL_THRESHOLD_SEC,
    ),
    checkIntervalSec: readEnvInt(
      env,
      RUN_STALL_CHECK_INTERVAL_SEC_ENV,
      DEFAULT_RUN_STALL_CHECK_INTERVAL_SEC,
      MIN_RUN_STALL_CHECK_INTERVAL_SEC,
      MAX_RUN_STALL_CHECK_INTERVAL_SEC,
    ),
    pageSize: readEnvInt(env, RUN_STALL_PAGE_SIZE_ENV, DEFAULT_RUN_STALL_PAGE_SIZE, MIN_RUN_STALL_PAGE_SIZE, MAX_RUN_STALL_PAGE_SIZE),
  };
}

/** True when the environment value is what the effective value comes from. */
function envDeclares(env: Record<string, string | undefined>, key: RunStallKey): boolean {
  const raw = env[RUN_STALL_ENV_KEYS[key]];
  if (key === "enabled") {
    const trimmed = raw?.trim().toLowerCase();
    return Boolean(trimmed) && (RUN_STALL_OFF_WORDS.includes(trimmed!) || trimmed === "1" || trimmed === "true" || trimmed === "on" || trimmed === "yes");
  }
  const parsed = raw?.trim();
  if (!parsed || !/^\d+$/.test(parsed)) return false;
  const value = Number(parsed);
  const [min, max] =
    key === "thresholdSec"
      ? [MIN_RUN_STALL_THRESHOLD_SEC, MAX_RUN_STALL_THRESHOLD_SEC]
      : key === "checkIntervalSec"
        ? [MIN_RUN_STALL_CHECK_INTERVAL_SEC, MAX_RUN_STALL_CHECK_INTERVAL_SEC]
        : [MIN_RUN_STALL_PAGE_SIZE, MAX_RUN_STALL_PAGE_SIZE];
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * The stored settings value, or null when the row holds nothing usable, so a
 * hand-edited row falls back to the environment instead of breaking the read.
 */
export function normalizeRunStall(raw: unknown): RunStallValues | null {
  const parsed = runStallSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective settings and where each one came from. `stored` is the raw
 * `general.runStall` value; an unreadable one counts as absent, so the
 * environment (or the default) applies instead.
 */
export function resolveRunStall(options: { stored?: unknown; env?: Record<string, string | undefined> } = {}): ResolvedRunStall {
  const env = options.env ?? {};
  const fromEnv = readRunStallFromEnv(env);
  const envSource = (key: RunStallKey): RunStallSource => (envDeclares(env, key) ? "env" : "default");
  const stored = normalizeRunStall(options.stored);
  const sources = {} as Record<RunStallKey, RunStallSource>;
  if (stored) {
    const storedKeys =
      options.stored && typeof options.stored === "object" ? (options.stored as Record<string, unknown>) : {};
    for (const key of RUN_STALL_KEYS) {
      sources[key] = key in storedKeys ? "settings" : envSource(key);
    }
    return { settings: stored, sources };
  }
  for (const key of RUN_STALL_KEYS) sources[key] = envSource(key);
  return { settings: fromEnv, sources };
}

/** A patch over the effective values, the shape that gets stored. */
export function mergeRunStall(base: RunStallValues, patch: RunStallPatch): RunStallValues {
  return {
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    thresholdSec: patch.thresholdSec === undefined ? base.thresholdSec : patch.thresholdSec,
    checkIntervalSec: patch.checkIntervalSec === undefined ? base.checkIntervalSec : patch.checkIntervalSec,
    pageSize: patch.pageSize === undefined ? base.pageSize : patch.pageSize,
  };
}
