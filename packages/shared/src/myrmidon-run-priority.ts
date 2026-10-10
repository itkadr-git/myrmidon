// myrmidon(1.6.5 RUN-PRIORITY A): run queue priority — role, issue priority,
// current release and aging, with live instance settings.
//
// A queued run's effective weight is
//
//     weight = max(role weight, issue-priority weight)
//            + release bonus           (issue tagged with the current release)
//            + aging bonus             (steps with the wait, capped)
//
// and once the run has waited longer than the starvation limit it gets the
// top weight outright, so a FIFO queue can never starve anybody forever.
//
// Settings follow the same precedence as the run admission limits
// (`myrmidon-runtime-limits.ts`): the stored `instance_settings.general.runPriority`
// row wins, then the `MYRMIDON_*` environment, then the defaults here. The
// server re-reads the stored row on every settings write and on startup, so a
// changed weight reaches the queue without a restart — the module itself is
// pure and never touches the database.
//
// When the feature is switched off every weight is 0 and the sweeps keep
// their pre-feature ordering (oldest queued run first).

import { z } from "zod";

/** Environment variable per setting — the defaults when nothing is stored. */
export const RUN_PRIORITY_ENV_KEYS = {
  enabled: "MYRMIDON_RUN_PRIORITY_ENABLED",
  roleWeights: "MYRMIDON_RUN_PRIORITY_ROLE_WEIGHTS",
  defaultRoleWeight: "MYRMIDON_RUN_PRIORITY_DEFAULT_ROLE_WEIGHT",
  issuePriorityWeights: "MYRMIDON_RUN_PRIORITY_ISSUE_WEIGHTS",
  currentRelease: "MYRMIDON_CURRENT_RELEASE",
  releaseBonus: "MYRMIDON_RUN_RELEASE_BONUS",
  agingStepMinutes: "MYRMIDON_RUN_AGING_STEP_MIN",
  agingStepWeight: "MYRMIDON_RUN_AGING_STEP_WEIGHT",
  agingMaxBonus: "MYRMIDON_RUN_AGING_MAX_BONUS",
  starvationLimitMinutes: "MYRMIDON_RUN_STARVATION_LIMIT_MIN",
  starvationTopWeight: "MYRMIDON_RUN_STARVATION_TOP_WEIGHT",
} as const;

/**
 * Default role weights: review and release first, then lead, then engineer
 * and docs, everything else (including the built-in `general`) at the floor.
 * Keys are compared case-insensitively against `agents.role`; an operator
 * overrides or extends them from the settings.
 */
export const DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS: Record<string, number> = {
  review: 90,
  release: 90,
  lead: 80,
  engineer: 50,
  docs: 50,
};

/** The weight of a role that has no explicit entry. */
export const DEFAULT_RUN_PRIORITY_ROLE_WEIGHT = 30;

/**
 * Issue-priority weights — the order mirrors `issueRunPriorityRank` in the
 * heartbeat service (critical > high > medium > low). `none` is a run without
 * a priority value or without an issue at all (the latter gets no issue
 * weight in the scoring, see `runPriorityWeight`).
 */
export const DEFAULT_RUN_PRIORITY_ISSUE_WEIGHTS: Record<string, number> = {
  critical: 100,
  high: 80,
  medium: 60,
  low: 40,
  none: 20,
};

export const DEFAULT_RUN_PRIORITY_RELEASE_BONUS = 20;
export const DEFAULT_RUN_PRIORITY_AGING_STEP_MINUTES = 10;
export const DEFAULT_RUN_PRIORITY_AGING_STEP_WEIGHT = 5;
export const DEFAULT_RUN_PRIORITY_AGING_MAX_BONUS = 50;
export const DEFAULT_RUN_PRIORITY_STARVATION_LIMIT_MINUTES = 90;
export const DEFAULT_RUN_PRIORITY_STARVATION_TOP_WEIGHT = 10_000;

/** The full settings shape. */
export interface RunPrioritySettings {
  enabled: boolean;
  /** Role key (lowercase) -> weight. */
  roleWeights: Record<string, number>;
  defaultRoleWeight: number;
  /** Issue priority (lowercase) -> weight; the `none` key covers unknown values. */
  issuePriorityWeights: Record<string, number>;
  /** The release tag that earns the bonus, e.g. "1.6.5-rc.6"; null when off. */
  currentRelease: string | null;
  releaseBonus: number;
  /** Effective weight grows this much per this many minutes of waiting... */
  agingStepMinutes: number;
  agingStepWeight: number;
  /** ...but never past this total bonus. */
  agingMaxBonus: number;
  /** Waiting this long (minutes) grants the top weight outright. */
  starvationLimitMinutes: number;
  starvationTopWeight: number;
}

export const runPrioritySettingsSchema = z
  .object({
    enabled: z.boolean(),
    roleWeights: z.record(z.string(), z.number().finite()),
    defaultRoleWeight: z.number().int().min(0).max(1000),
    issuePriorityWeights: z.record(z.string(), z.number().finite()),
    currentRelease: z.string().trim().min(1).max(64).nullable(),
    releaseBonus: z.number().int().min(0).max(1000),
    agingStepMinutes: z.number().int().min(0).max(24 * 60),
    agingStepWeight: z.number().int().min(0).max(1000),
    agingMaxBonus: z.number().int().min(0).max(10_000),
    starvationLimitMinutes: z.number().int().min(0).max(7 * 24 * 60),
    starvationTopWeight: z.number().int().min(0).max(1_000_000),
  })
  .strict();

/**
 * A stored `general.runPriority` row: everything optional (a row saved before
 * a key existed must still parse), values clamped on normalize below. Lenient
 * by design, like the bot-disk rows: an invalid value reads as absent.
 */
export const storedRunPrioritySchema = z
  .object({
    enabled: z.boolean().optional(),
    roleWeights: z.record(z.string(), z.number().finite()).optional(),
    defaultRoleWeight: z.number().int().min(0).max(1000).optional(),
    issuePriorityWeights: z.record(z.string(), z.number().finite()).optional(),
    currentRelease: z.string().trim().min(1).max(64).nullable().optional(),
    releaseBonus: z.number().int().min(0).max(1000).optional(),
    agingStepMinutes: z.number().int().min(0).max(24 * 60).optional(),
    agingStepWeight: z.number().int().min(0).max(1000).optional(),
    agingMaxBonus: z.number().int().min(0).max(10_000).optional(),
    starvationLimitMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
    starvationTopWeight: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

/** Body of `PATCH /api/myrmidon/run-priority`: any subset of the values. */
export const patchRunPrioritySchema = storedRunPrioritySchema;

export type StoredRunPriority = z.infer<typeof storedRunPrioritySchema>;
export type RunPriorityPatch = z.infer<typeof patchRunPrioritySchema>;

/** A weight map with only non-negative finite values, keys lowercased. */
function normalizeWeightMap(
  raw: unknown,
  fallback: Record<string, number>,
): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...fallback };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim().toLowerCase();
    if (!name || typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    out[name] = Math.round(value);
  }
  return out;
}

/** `a=90,release=80` -> `{ a: 90, release: 80 }`; null when unusable. */
function parseEnvWeightMap(raw: string | undefined): Record<string, number> | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const out: Record<string, number> = {};
  for (const part of trimmed.split(",")) {
    const [key, value] = part.split("=").map((s) => s?.trim());
    if (!key || !value) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    out[key.toLowerCase()] = Math.round(n);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** An environment non-negative integer; null when absent or unusable. */
function parseEnvNumber(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

/** The settings as the environment declares them, with the built-in defaults. */
export function readRunPriorityFromEnv(
  env: Record<string, string | undefined> = {},
): RunPrioritySettings {
  const enabledRaw = env[RUN_PRIORITY_ENV_KEYS.enabled]?.trim();
  return {
    enabled:
      enabledRaw === undefined || enabledRaw === ""
        ? true
        : !(enabledRaw === "0" || enabledRaw.toLowerCase() === "off" || enabledRaw.toLowerCase() === "false"),
    roleWeights:
      parseEnvWeightMap(env[RUN_PRIORITY_ENV_KEYS.roleWeights]) ?? { ...DEFAULT_RUN_PRIORITY_ROLE_WEIGHTS },
    defaultRoleWeight: parseEnvNumber(env[RUN_PRIORITY_ENV_KEYS.defaultRoleWeight]) ?? DEFAULT_RUN_PRIORITY_ROLE_WEIGHT,
    issuePriorityWeights:
      parseEnvWeightMap(env[RUN_PRIORITY_ENV_KEYS.issuePriorityWeights]) ?? { ...DEFAULT_RUN_PRIORITY_ISSUE_WEIGHTS },
    currentRelease: env[RUN_PRIORITY_ENV_KEYS.currentRelease]?.trim() || null,
    releaseBonus: parseEnvNumber(env[RUN_PRIORITY_ENV_KEYS.releaseBonus]) ?? DEFAULT_RUN_PRIORITY_RELEASE_BONUS,
    agingStepMinutes: parseEnvNumber(env[RUN_PRIORITY_ENV_KEYS.agingStepMinutes]) ?? DEFAULT_RUN_PRIORITY_AGING_STEP_MINUTES,
    agingStepWeight: parseEnvNumber(env[RUN_PRIORITY_ENV_KEYS.agingStepWeight]) ?? DEFAULT_RUN_PRIORITY_AGING_STEP_WEIGHT,
    agingMaxBonus: parseEnvNumber(env[RUN_PRIORITY_ENV_KEYS.agingMaxBonus]) ?? DEFAULT_RUN_PRIORITY_AGING_MAX_BONUS,
    starvationLimitMinutes:
      parseEnvNumber(env[RUN_PRIORITY_ENV_KEYS.starvationLimitMinutes]) ?? DEFAULT_RUN_PRIORITY_STARVATION_LIMIT_MINUTES,
    starvationTopWeight:
      parseEnvNumber(env[RUN_PRIORITY_ENV_KEYS.starvationTopWeight]) ?? DEFAULT_RUN_PRIORITY_STARVATION_TOP_WEIGHT,
  };
}

/**
 * The stored row over the fallback (the environment, then the defaults),
 * key by key; anything unusable in the row falls back. Always returns a
 * complete settings object — the feature must never fail a sweep on a bad row.
 */
export function normalizeRunPrioritySettings(
  raw: unknown,
  fallback: RunPrioritySettings = readRunPriorityFromEnv({}),
): RunPrioritySettings {
  const parsed = storedRunPrioritySchema.safeParse(raw ?? {});
  const row = parsed.success ? parsed.data : {};
  return {
    enabled: row.enabled ?? fallback.enabled,
    roleWeights: row.roleWeights ? normalizeWeightMap(row.roleWeights, fallback.roleWeights) : { ...fallback.roleWeights },
    defaultRoleWeight: row.defaultRoleWeight ?? fallback.defaultRoleWeight,
    issuePriorityWeights: row.issuePriorityWeights
      ? normalizeWeightMap(row.issuePriorityWeights, fallback.issuePriorityWeights)
      : { ...fallback.issuePriorityWeights },
    currentRelease:
      row.currentRelease === undefined ? fallback.currentRelease : row.currentRelease?.trim() || null,
    releaseBonus: row.releaseBonus ?? fallback.releaseBonus,
    agingStepMinutes: row.agingStepMinutes ?? fallback.agingStepMinutes,
    agingStepWeight: row.agingStepWeight ?? fallback.agingStepWeight,
    agingMaxBonus: row.agingMaxBonus ?? fallback.agingMaxBonus,
    starvationLimitMinutes: row.starvationLimitMinutes ?? fallback.starvationLimitMinutes,
    starvationTopWeight: row.starvationTopWeight ?? fallback.starvationTopWeight,
  };
}

/** True when the stored row declares any key (it then beats the environment). */
export function storedRunPriorityDeclares(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return Object.keys(raw).length > 0;
}

/** Merge a PATCH body into the settings in force (null clears the release tag). */
export function mergeRunPrioritySettings(
  base: RunPrioritySettings,
  patch: RunPriorityPatch,
): RunPrioritySettings {
  const next: RunPrioritySettings = { ...base, roleWeights: { ...base.roleWeights }, issuePriorityWeights: { ...base.issuePriorityWeights } };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.roleWeights !== undefined) next.roleWeights = normalizeWeightMap(patch.roleWeights, base.roleWeights);
  if (patch.defaultRoleWeight !== undefined) next.defaultRoleWeight = patch.defaultRoleWeight;
  if (patch.issuePriorityWeights !== undefined)
    next.issuePriorityWeights = normalizeWeightMap(patch.issuePriorityWeights, base.issuePriorityWeights);
  if (patch.currentRelease !== undefined) next.currentRelease = patch.currentRelease?.trim() || null;
  if (patch.releaseBonus !== undefined) next.releaseBonus = patch.releaseBonus;
  if (patch.agingStepMinutes !== undefined) next.agingStepMinutes = patch.agingStepMinutes;
  if (patch.agingStepWeight !== undefined) next.agingStepWeight = patch.agingStepWeight;
  if (patch.agingMaxBonus !== undefined) next.agingMaxBonus = patch.agingMaxBonus;
  if (patch.starvationLimitMinutes !== undefined) next.starvationLimitMinutes = patch.starvationLimitMinutes;
  if (patch.starvationTopWeight !== undefined) next.starvationTopWeight = patch.starvationTopWeight;
  return next;
}

/**
 * A release tag matches a label or branch name case-insensitively when one
 * contains the other (the shorter side must be at least 3 chars so a tag like
 * "rc" cannot swallow every branch that happens to contain those letters).
 * This is what "the task carries the current release" means: `rc.6` matches
 * label `1.6.5-rc.6` and branch `myr/1.6.5-rc.6-x`.
 */
export function releaseTagMatches(tag: string | null | undefined, candidate: string | null | undefined): boolean {
  const t = tag?.toLowerCase().trim();
  const c = candidate?.toLowerCase().trim();
  if (!t || !c) return false;
  // Full-string equality always matches, whatever the length.
  if (c === t) return true;
  // Containment needs both sides to be at least 3 chars: a two-letter tag
  // ("rc") must not swallow every branch that merely contains those letters.
  if (Math.min(t.length, c.length) < 3) return false;
  return c.includes(t) || t.includes(c);
}

/** What the scorer knows about one queued run. */
export interface RunPriorityRunInput {
  /** `agents.role` of the run's agent. */
  role: string | null | undefined;
  /** False for a run without an issue in its context snapshot. */
  hasIssue: boolean;
  /** `issues.priority` when the run carries an issue. */
  issuePriority: string | null | undefined;
  /** The issue label or run branch matched the current release tag. */
  releaseMatched: boolean;
  /** `heartbeatRuns.createdAt` (epoch ms) — the wait is measured from here. */
  createdAtMs: number;
}

const MINUTE_MS = 60_000;

/**
 * The effective weight of a queued run at `nowMs` (larger starts first).
 * Switched off, every run scores 0 and the caller falls back to its
 * pre-feature ordering.
 */
export function runPriorityWeight(
  input: RunPriorityRunInput,
  settings: RunPrioritySettings,
  nowMs: number = Date.now(),
): number {
  if (!settings.enabled) return 0;
  const waitedMs = Math.max(0, nowMs - input.createdAtMs);
  if (settings.starvationLimitMinutes > 0 && waitedMs >= settings.starvationLimitMinutes * MINUTE_MS) {
    return settings.starvationTopWeight;
  }
  const roleKey = input.role?.trim().toLowerCase();
  const roleWeight =
    (roleKey ? settings.roleWeights[roleKey] : undefined) ?? settings.defaultRoleWeight;
  let issueWeight = 0;
  if (input.hasIssue) {
    const priorityKey = input.issuePriority?.trim().toLowerCase() || "none";
    issueWeight =
      settings.issuePriorityWeights[priorityKey] ??
      settings.issuePriorityWeights["none"] ??
      DEFAULT_RUN_PRIORITY_ISSUE_WEIGHTS.none ??
      0;
  }
  let weight = Math.max(roleWeight, issueWeight);
  if (input.releaseMatched) weight += settings.releaseBonus;
  if (settings.agingStepMinutes > 0 && settings.agingStepWeight > 0) {
    const steps = Math.floor(waitedMs / (settings.agingStepMinutes * MINUTE_MS));
    weight += Math.min(settings.agingMaxBonus, steps * settings.agingStepWeight);
  }
  return weight;
}
