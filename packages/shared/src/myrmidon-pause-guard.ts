import { z } from "zod";

/**
 * The forgotten-pause guard (myrmidon 1.6.5 PAUSE-GUARD).
 *
 * A board-wide sweep lifts operator pauses that were left behind: an agent
 * whose `status` is `paused` with `pause_reason` `manual` and whose
 * `paused_at` is older than the threshold is resumed through the same wake
 * chain the resume route uses, so its queued runs and stranded tasks come
 * back to life. Pauses the board set for its own reasons (`budget`, `system`,
 * `company_archived`, `import`) are never touched.
 *
 * The values are the same on every install; in the deployment they come from
 * the environment (`MYRMIDON_PAUSE_GUARD_*`) and this module also stores them
 * in `instance_settings.general.pauseGuard`, so an operator can change them
 * from the settings page without restarting the server.
 *
 * Precedence, per value, mirrors the run admission limits
 * (packages/shared/src/myrmidon-runtime-limits.ts):
 *
 * - the stored settings value, when the key is present in
 *   `general.pauseGuard`;
 * - otherwise the environment variable, which stays the default for the first
 *   start on an instance that has never saved these settings;
 * - otherwise the built-in default: enabled, threshold 20 minutes, interval
 *   600 seconds, no allowlisted names and at most 20 resumes per pass.
 *
 * The feature is a defect fix (CONVENTIONS.md section 8): it ships enabled and
 * only an explicit off value disables it.
 */

/** Environment variable per setting — the names the guard module reads. */
export const PAUSE_GUARD_ENV_KEYS = {
  enabled: "MYRMIDON_PAUSE_GUARD_ENABLED",
  thresholdMinutes: "MYRMIDON_PAUSE_GUARD_THRESHOLD_MIN",
  intervalSec: "MYRMIDON_PAUSE_GUARD_INTERVAL_SEC",
  allowlist: "MYRMIDON_PAUSE_GUARD_ALLOWLIST",
  maxResumesPerPass: "MYRMIDON_PAUSE_GUARD_MAX_RESUMES_PER_PASS",
} as const;

export const PAUSE_GUARD_SETTING_KEYS = [
  "enabled",
  "thresholdMinutes",
  "intervalSec",
  "allowlist",
  "maxResumesPerPass",
] as const;

export type PauseGuardSettingKey = (typeof PAUSE_GUARD_SETTING_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type PauseGuardSettingsSource = "settings" | "env" | "default";

/** The pause the operator's own maintenance script used: 20 minutes. */
export const DEFAULT_PAUSE_GUARD_THRESHOLD_MINUTES = 20;
/** The cadence of the operator's own maintenance script: every 10 minutes. */
export const DEFAULT_PAUSE_GUARD_INTERVAL_SEC = 600;
/** At most this many resumes in one pass; the rest wait for the next one. */
export const DEFAULT_PAUSE_GUARD_MAX_RESUMES_PER_PASS = 20;

/**
 * Bounds. Both the environment reader and the settings API validate against
 * them, so a value that reached the row through one path is acceptable to the
 * other. The threshold is read in minutes because that is how an operator
 * thinks about a forgotten pause.
 */
export const MIN_PAUSE_GUARD_THRESHOLD_MINUTES = 1;
export const MAX_PAUSE_GUARD_THRESHOLD_MINUTES = 24 * 60;
export const MIN_PAUSE_GUARD_INTERVAL_SEC = 15;
export const MAX_PAUSE_GUARD_INTERVAL_SEC = 24 * 60 * 60;
export const MIN_PAUSE_GUARD_MAX_RESUMES_PER_PASS = 1;
export const MAX_PAUSE_GUARD_MAX_RESUMES_PER_PASS = 200;

/** The canonical stored shape of `instance_settings.general.pauseGuard`. */
export const pauseGuardSettingsSchema = z
  .object({
    enabled: z.boolean(),
    thresholdMinutes: z
      .number()
      .int()
      .min(MIN_PAUSE_GUARD_THRESHOLD_MINUTES)
      .max(MAX_PAUSE_GUARD_THRESHOLD_MINUTES),
    intervalSec: z.number().int().min(MIN_PAUSE_GUARD_INTERVAL_SEC).max(MAX_PAUSE_GUARD_INTERVAL_SEC),
    /** Agent names the guard must never resume (a maintenance allowlist). */
    allowlist: z.array(z.string()),
    maxResumesPerPass: z
      .number()
      .int()
      .min(MIN_PAUSE_GUARD_MAX_RESUMES_PER_PASS)
      .max(MAX_PAUSE_GUARD_MAX_RESUMES_PER_PASS),
  })
  .strict();

/**
 * What a stored row may hold: the canonical shape with every key optional, so
 * a row saved by an older server still counts as stored (its missing keys
 * resolve from the environment or the default) and a hand-edited row with an
 * unusable value is ignored key by key.
 */
export const storedPauseGuardSettingsSchema = pauseGuardSettingsSchema.partial();

/** Body of `PATCH /api/myrmidon/pause-guard`: any subset of the settings. */
export const patchPauseGuardSettingsSchema = pauseGuardSettingsSchema.partial().strict();

export type PauseGuardSettings = z.infer<typeof pauseGuardSettingsSchema>;
export type StoredPauseGuardSettings = z.infer<typeof storedPauseGuardSettingsSchema>;
export type PauseGuardSettingsPatch = z.infer<typeof patchPauseGuardSettingsSchema>;

export interface ResolvedPauseGuardSettings {
  settings: PauseGuardSettings;
  sources: Record<PauseGuardSettingKey, PauseGuardSettingsSource>;
}

const OFF_WORDS = new Set(["0", "off", "false", "no", "none"]);

/**
 * Master switch. Unset or an unrecognized value keeps the fix on: a typo must
 * not silently extinguish it (the same rule `MYRMIDON_RUN_STALL_ENABLED` and
 * `MYRMIDON_IDLE_PICKUP_ENABLED` follow).
 */
export function parsePauseGuardEnabled(raw: string | undefined, fallback = true): boolean {
  const text = raw?.trim().toLowerCase();
  if (!text) return fallback;
  return !OFF_WORDS.has(text);
}

/** An integer setting inside its bounds, or the fallback for anything else. */
export function parsePauseGuardInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

/**
 * A comma-separated allowlist of agent names. Empty entries are dropped and
 * the list is deduplicated, so `a, ,b,a` reads as `[a, b]`. Names are matched
 * case-insensitively (see `isAllowlistedName`), so the stored list keeps the
 * operator's casing while the comparison does not care about it.
 */
export function parsePauseGuardAllowlist(raw: string | undefined): string[] {
  const text = raw?.trim();
  if (!text) return [];
  return normalizePauseGuardAllowlist(text.split(","));
}

/** The same normalization for an already-parsed list (a stored row, an API body). */
export function normalizePauseGuardAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** True when an agent name is on the allowlist; the comparison ignores case. */
export function isAllowlistedName(name: string | null | undefined, allowlist: readonly string[]): boolean {
  if (typeof name !== "string") return false;
  const key = name.trim().toLowerCase();
  if (!key) return false;
  return allowlist.some((entry) => entry.trim().toLowerCase() === key);
}

/** The settings as the environment declares them, with the built-in defaults. */
export function readPauseGuardSettingsFromEnv(
  env: Record<string, string | undefined> = {},
): PauseGuardSettings {
  return {
    enabled: parsePauseGuardEnabled(env[PAUSE_GUARD_ENV_KEYS.enabled]),
    thresholdMinutes: parsePauseGuardInt(
      env[PAUSE_GUARD_ENV_KEYS.thresholdMinutes],
      DEFAULT_PAUSE_GUARD_THRESHOLD_MINUTES,
      MIN_PAUSE_GUARD_THRESHOLD_MINUTES,
      MAX_PAUSE_GUARD_THRESHOLD_MINUTES,
    ),
    intervalSec: parsePauseGuardInt(
      env[PAUSE_GUARD_ENV_KEYS.intervalSec],
      DEFAULT_PAUSE_GUARD_INTERVAL_SEC,
      MIN_PAUSE_GUARD_INTERVAL_SEC,
      MAX_PAUSE_GUARD_INTERVAL_SEC,
    ),
    allowlist: parsePauseGuardAllowlist(env[PAUSE_GUARD_ENV_KEYS.allowlist]),
    maxResumesPerPass: parsePauseGuardInt(
      env[PAUSE_GUARD_ENV_KEYS.maxResumesPerPass],
      DEFAULT_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
      MIN_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
      MAX_PAUSE_GUARD_MAX_RESUMES_PER_PASS,
    ),
  };
}

/** True when the environment declares a value the effective setting can come from. */
function envDeclares(env: Record<string, string | undefined>, key: PauseGuardSettingKey): boolean {
  const raw = env[PAUSE_GUARD_ENV_KEYS[key]];
  if (typeof raw !== "string") return false;
  const text = raw.trim();
  if (!text) return false;
  if (key === "enabled") return true;
  if (key === "allowlist") return true;
  return /^\d+$/.test(text);
}

/**
 * The stored row's usable values, or null when the row holds nothing this
 * module can read. Keys the row lacks are reported as absent (not filled in),
 * so the caller can resolve them from the environment or the default.
 */
export function normalizeStoredPauseGuardSettings(raw: unknown): Partial<PauseGuardSettings> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = storedPauseGuardSettingsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  const out: Partial<PauseGuardSettings> = {};
  if (data.enabled !== undefined) out.enabled = data.enabled;
  if (data.thresholdMinutes !== undefined) out.thresholdMinutes = data.thresholdMinutes;
  if (data.intervalSec !== undefined) out.intervalSec = data.intervalSec;
  if (data.allowlist !== undefined) out.allowlist = normalizePauseGuardAllowlist(data.allowlist);
  if (data.maxResumesPerPass !== undefined) out.maxResumesPerPass = data.maxResumesPerPass;
  return out;
}

/**
 * Effective settings and where each one came from. `stored` is the raw
 * `general.pauseGuard` value; an unreadable one counts as absent, so the
 * environment (or the default) applies instead.
 */
export function resolvePauseGuardSettings(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedPauseGuardSettings {
  const env = options.env ?? {};
  const fromEnv = readPauseGuardSettingsFromEnv(env);
  const sourceOf = (key: PauseGuardSettingKey): PauseGuardSettingsSource =>
    envDeclares(env, key) ? "env" : "default";
  const stored = normalizeStoredPauseGuardSettings(options.stored);
  const settings: PauseGuardSettings = {
    enabled: stored?.enabled ?? fromEnv.enabled,
    thresholdMinutes: stored?.thresholdMinutes ?? fromEnv.thresholdMinutes,
    intervalSec: stored?.intervalSec ?? fromEnv.intervalSec,
    allowlist: stored?.allowlist ?? fromEnv.allowlist,
    maxResumesPerPass: stored?.maxResumesPerPass ?? fromEnv.maxResumesPerPass,
  };
  const sources = {} as Record<PauseGuardSettingKey, PauseGuardSettingsSource>;
  for (const key of PAUSE_GUARD_SETTING_KEYS) {
    sources[key] = stored && stored[key] !== undefined ? "settings" : sourceOf(key);
  }
  return { settings, sources };
}

/** A patch over the effective settings, the canonical shape that gets stored. */
export function mergePauseGuardSettings(
  base: PauseGuardSettings,
  patch: PauseGuardSettingsPatch,
): PauseGuardSettings {
  return {
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    thresholdMinutes: patch.thresholdMinutes ?? base.thresholdMinutes,
    intervalSec: patch.intervalSec ?? base.intervalSec,
    allowlist: patch.allowlist === undefined ? base.allowlist : normalizePauseGuardAllowlist(patch.allowlist),
    maxResumesPerPass: patch.maxResumesPerPass ?? base.maxResumesPerPass,
  };
}