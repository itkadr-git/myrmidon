// myrmidon(TEAM-LIVENESS-SETTINGS): the knobs of the three automatic
// team-liveness behaviours as one settings area.
//
// The behaviours are AUTO-RESUME (an agent left in `error` is resumed with
// backoff), RUN-STALL (a run whose recorded progress stopped advancing is
// interrupted and its task returns to `todo`) and IDLE-PICKUP
// (wake-on-ready-work: an idle agent with a ready `todo` is woken). Before
// this module each behaviour read its own `MYRMIDON_*` environment variables
// only, so changing a knob meant editing the deployment and restarting the
// server — which drops every run in flight.
//
// This module owns the stored shape and the resolution rule; the deployment
// keeps the environment variables as the value an instance that has never
// saved these settings starts from. Precedence, per key, is decided here once:
//
// - the stored value, when the key is present in `instance_settings.general.teamLiveness`;
// - otherwise the environment variable;
// - otherwise the built-in default.
//
// `resolveTeamLivenessSettings` reports that decision per key (`sources`), so
// a settings page can show the operator which layer actually controls a field.
// A source is claimed as "env" only when the environment value passes the same
// validation the behaviour applies: a garbage value (`0` for the stall
// threshold, `maybe` for a switch) keeps the default and is reported as
// "default", never as "env" — the operator must not read "Environment"
// against a field the environment does not control.
//
// The stored object is a partial: every key is optional, so a row saved
// before a key existed still parses and the missing key keeps resolving from
// the environment or the default. A write stores the merged object; the
// server-side normalizer carries the key through every general write
// (`normalizeGeneralSettings`), the same trap every instance-settings area has.
//
// Per-agent overrides live on the agent card under `adapterConfig.teamLiveness`
// (option A, never a DB migration), resolved with the instance values as the
// fallback — see `resolveAgentTeamLiveness`. This mirrors `parallelHelpers`:
// the card carries the opt-out, the instance carries the default.

import { z } from "zod";

/**
 * Environment variable per key. The names are the ones the behaviour modules
 * already read, so an existing deployment keeps working unchanged.
 */
export const TEAM_LIVENESS_ENV_KEYS = {
  autoResumeEnabled: "MYRMIDON_AUTO_RESUME_ENABLED",
  runStallEnabled: "MYRMIDON_RUN_STALL_ENABLED",
  runStallThresholdSec: "MYRMIDON_RUN_STALL_THRESHOLD_SEC",
  idlePickupEnabled: "MYRMIDON_IDLE_PICKUP_ENABLED",
  idlePickupIntervalSec: "MYRMIDON_IDLE_PICKUP_INTERVAL_SEC",
  idlePickupWakeBudgetPerMin: "MYRMIDON_IDLE_PICKUP_WAKE_BUDGET_PER_MIN",
  idlePickupWakeBatch: "MYRMIDON_IDLE_PICKUP_WAKE_BATCH",
} as const;

export const TEAM_LIVENESS_KEYS = [
  "autoResumeEnabled",
  "runStallEnabled",
  "runStallThresholdSec",
  "idlePickupEnabled",
  "idlePickupIntervalSec",
  "idlePickupWakeBudgetPerMin",
  "idlePickupWakeBatch",
] as const;

export type TeamLivenessKey = (typeof TEAM_LIVENESS_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type TeamLivenessSource = "settings" | "env" | "default";

/** The keys whose value is a switch rather than a number. */
export const TEAM_LIVENESS_BOOLEAN_KEYS = [
  "autoResumeEnabled",
  "runStallEnabled",
  "idlePickupEnabled",
] as const;

export type TeamLivenessBooleanKey = (typeof TEAM_LIVENESS_BOOLEAN_KEYS)[number];
export type TeamLivenessNumberKey = Exclude<TeamLivenessKey, TeamLivenessBooleanKey>;

/** The effective knob values the three behaviours run with. */
export interface TeamLivenessSettings {
  /** AUTO-RESUME: the board resumes an agent left in `error` on its own. */
  autoResumeEnabled: boolean;
  /** RUN-STALL: progress-based run liveness interrupts a silent run. */
  runStallEnabled: boolean;
  /** RUN-STALL: silence window after which a run counts as stalled (seconds). */
  runStallThresholdSec: number;
  /** IDLE-PICKUP: the board wakes an idle agent with a ready task. */
  idlePickupEnabled: boolean;
  /** IDLE-PICKUP: how often the wake pass is allowed to look (seconds). */
  idlePickupIntervalSec: number;
  /** IDLE-PICKUP: company-wide ceiling on wakes per minute. */
  idlePickupWakeBudgetPerMin: number;
  /** IDLE-PICKUP: the share of that minute one pass may spend at once. */
  idlePickupWakeBatch: number;
}

/** Bounds per numeric key: outside them the key keeps the default. */
export const TEAM_LIVENESS_NUMBER_BOUNDS: Record<
  TeamLivenessNumberKey,
  { min: number; max: number; default: number }
> = {
  // The ticket's own default: the 20 minutes the operator watchdog used.
  runStallThresholdSec: { min: 60, max: 86_400, default: 1_200 },
  // Values below the minimum are clamped up, not rejected (30 s is the default).
  idlePickupIntervalSec: { min: 5, max: Number.MAX_SAFE_INTEGER, default: 30 },
  // "At most 5 wakes a minute per company, in batches" — the ticket's ceiling.
  idlePickupWakeBudgetPerMin: { min: 1, max: 60, default: 5 },
  idlePickupWakeBatch: { min: 1, max: 60, default: 5 },
};

/** The values in force when neither stored settings nor the environment say otherwise. */
export const DEFAULT_TEAM_LIVENESS_SETTINGS: TeamLivenessSettings = {
  autoResumeEnabled: true,
  runStallEnabled: true,
  runStallThresholdSec: TEAM_LIVENESS_NUMBER_BOUNDS.runStallThresholdSec.default,
  idlePickupEnabled: true,
  idlePickupIntervalSec: TEAM_LIVENESS_NUMBER_BOUNDS.idlePickupIntervalSec.default,
  idlePickupWakeBudgetPerMin: TEAM_LIVENESS_NUMBER_BOUNDS.idlePickupWakeBudgetPerMin.default,
  idlePickupWakeBatch: TEAM_LIVENESS_NUMBER_BOUNDS.idlePickupWakeBatch.default,
};
const positiveInt = z.number().int().positive();

/**
 * What a stored `instance_settings.general.teamLiveness` row may hold. Every
 * key is optional: a row saved before a key existed still parses, and the
 * missing key resolves from the environment or the default. `.strict()` keeps
 * a typo out of the row instead of silently ignoring it.
 */
export const storedTeamLivenessSettingsSchema = z
  .object({
    autoResumeEnabled: z.boolean().optional(),
    runStallEnabled: z.boolean().optional(),
    runStallThresholdSec: positiveInt.optional(),
    idlePickupEnabled: z.boolean().optional(),
    idlePickupIntervalSec: positiveInt.optional(),
    idlePickupWakeBudgetPerMin: positiveInt.optional(),
    idlePickupWakeBatch: positiveInt.optional(),
  })
  .strict();

/** The stored shape's patch form: the same object, every key optional. */
export const patchTeamLivenessSettingsSchema = storedTeamLivenessSettingsSchema;

export type TeamLivenessSettingsPatch = z.infer<typeof storedTeamLivenessSettingsSchema>;

/** The canonical, fully resolved shape — what the API reports as effective. */
export const teamLivenessSettingsSchema = z
  .object({
    autoResumeEnabled: z.boolean(),
    runStallEnabled: z.boolean(),
    runStallThresholdSec: positiveInt,
    idlePickupEnabled: z.boolean(),
    idlePickupIntervalSec: positiveInt,
    idlePickupWakeBudgetPerMin: positiveInt,
    idlePickupWakeBatch: positiveInt,
  })
  .strict();

/** The switch rule every team-liveness module already applies. */
function readSwitch(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  // Unset or unrecognized keeps the fix on: a typo must not extinguish it.
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

function readEnvNumber(
  env: Record<string, string | undefined>,
  key: TeamLivenessNumberKey,
): { value: number; valid: boolean } {
  const bounds = TEAM_LIVENESS_NUMBER_BOUNDS[key];
  const raw = env[TEAM_LIVENESS_ENV_KEYS[key]]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return { value: bounds.default, valid: false };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return { value: bounds.default, valid: false };
  // A value above the ceiling is not the value in force: clamp it, and call
  // the source "env" only when the value the behaviour ends up with is the
  // environment one. (The stall threshold rejects out-of-range values instead
  // of clamping — see readTeamLivenessFromEnv.)
  if (key === "runStallThresholdSec") {
    if (parsed < bounds.min || parsed > bounds.max) return { value: bounds.default, valid: false };
    return { value: parsed, valid: true };
  }
  if (parsed > bounds.max) return { value: bounds.default, valid: false };
  return { value: Math.max(bounds.min, parsed), valid: true };
}

/** The values the environment alone produces, with the behaviours' own rules. */
export function readTeamLivenessFromEnv(
  env: Record<string, string | undefined> = {},
): TeamLivenessSettings {
  const runStallThresholdSec = readEnvNumber(env, "runStallThresholdSec");
  const idlePickupIntervalSec = readEnvNumber(env, "idlePickupIntervalSec");
  const perMinute = readEnvNumber(env, "idlePickupWakeBudgetPerMin");
  const batch = readEnvNumber(env, "idlePickupWakeBatch");
  return {
    autoResumeEnabled: readSwitch(env[TEAM_LIVENESS_ENV_KEYS.autoResumeEnabled]),
    runStallEnabled: readSwitch(env[TEAM_LIVENESS_ENV_KEYS.runStallEnabled]),
    runStallThresholdSec: runStallThresholdSec.value,
    idlePickupEnabled: readSwitch(env[TEAM_LIVENESS_ENV_KEYS.idlePickupEnabled]),
    idlePickupIntervalSec: idlePickupIntervalSec.value,
    // A pass never spends more of the minute than the minute holds.
    idlePickupWakeBudgetPerMin: perMinute.value,
    idlePickupWakeBatch: Math.min(perMinute.value, batch.value),
  };
}

/**
 * Whether the environment actually controls this key. True only when the
 * variable is set AND its value passes the same validation the behaviour
 * applies — see the module header.
 */
export function envDeclaresTeamLivenessKey(
  key: TeamLivenessKey,
  env: Record<string, string | undefined> = {},
): boolean {
  if (TEAM_LIVENESS_ENV_KEYS[key] === undefined) return false;
  const raw = env[TEAM_LIVENESS_ENV_KEYS[key]];
  if (raw === undefined || raw.trim() === "") return false;
  if ((TEAM_LIVENESS_BOOLEAN_KEYS as readonly string[]).includes(key)) {
    const value = raw.trim().toLowerCase();
    return ["0", "1", "false", "true", "off", "on", "no", "yes"].includes(value);
  }
  if (key === "idlePickupWakeBatch") {
    // The batch is clamped to the minute ceiling, so the environment controls
    // it only when its own value survives that clamp.
    const perMinute = readEnvNumber(env, "idlePickupWakeBudgetPerMin");
    const batch = readEnvNumber(env, "idlePickupWakeBatch");
    return batch.valid && batch.value <= perMinute.value;
  }
  return readEnvNumber(env, key as TeamLivenessNumberKey).valid;
}

/** A stored value that passes validation, or null when the row is unusable. */
function normalizeStoredTeamLiveness(stored: unknown): TeamLivenessSettingsPatch | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const parsed = storedTeamLivenessSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** A stored number, clamped by the same bounds the environment value obeys. */
function storedNumber(
  key: TeamLivenessNumberKey,
  value: number,
): { value: number; accepted: boolean } {
  const bounds = TEAM_LIVENESS_NUMBER_BOUNDS[key];
  if (!Number.isSafeInteger(value) || value <= 0) return { value: bounds.default, accepted: false };
  if (key === "runStallThresholdSec") {
    if (value < bounds.min || value > bounds.max) return { value: bounds.default, accepted: false };
    return { value, accepted: true };
  }
  if (value > bounds.max) return { value: bounds.max, accepted: true };
  return { value: Math.max(bounds.min, value), accepted: true };
}

/**
 * Write one resolved value. Indexing a settings object with a union key narrows
 * the target to `never` under a plain assignment, so the write goes through one
 * documented cast instead of a branch per key.
 */
function assignValue(
  target: TeamLivenessSettings,
  key: TeamLivenessKey,
  value: boolean | number,
): void {
  (target as unknown as Record<TeamLivenessKey, boolean | number>)[key] = value;
}

/** The effective values and, per key, the layer they came from. */
export interface ResolvedTeamLiveness {
  settings: TeamLivenessSettings;
  sources: Record<TeamLivenessKey, TeamLivenessSource>;
}

/**
 * Decide the effective value of every key once: stored settings, then the
 * environment, then the default. The environment layer is read through the
 * behaviours' own rules (`readTeamLivenessFromEnv`), so nothing here can hand
 * a behaviour a value it would have rejected.
 */
export function resolveTeamLivenessSettings(
  options: { stored?: unknown; env?: Record<string, string | undefined> } = {},
): ResolvedTeamLiveness {
  const env = options.env ?? {};
  const settings = readTeamLivenessFromEnv(env);
  const sources = {} as Record<TeamLivenessKey, TeamLivenessSource>;
  for (const key of TEAM_LIVENESS_KEYS) {
    sources[key] = envDeclaresTeamLivenessKey(key, env) ? "env" : "default";
  }
  const stored = normalizeStoredTeamLiveness(options.stored);
  if (stored) {
    for (const key of TEAM_LIVENESS_KEYS) {
      const value = stored[key];
      if (value === undefined) continue;
      if (typeof value === "boolean") {
        assignValue(settings, key, value);
        sources[key] = "settings";
        continue;
      }
      const accepted = storedNumber(key as TeamLivenessNumberKey, value);
      if (!accepted.accepted) continue;
      assignValue(settings, key, accepted.value);
      sources[key] = "settings";
    }
  }
  settings.idlePickupWakeBatch = Math.min(
    settings.idlePickupWakeBatch,
    settings.idlePickupWakeBudgetPerMin,
  );
  return { settings, sources };
}

/** Apply a validated patch onto effective values; the shape a write stores. */
export function mergeTeamLiveness(
  base: TeamLivenessSettings,
  patch: TeamLivenessSettingsPatch,
): TeamLivenessSettings {
  const next: TeamLivenessSettings = { ...base };
  for (const key of TEAM_LIVENESS_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value === "boolean") {
      assignValue(next, key, value);
      continue;
    }
    const accepted = storedNumber(key as TeamLivenessNumberKey, value);
    if (accepted.accepted) assignValue(next, key, accepted.value);
  }
  next.idlePickupWakeBatch = Math.min(next.idlePickupWakeBatch, next.idlePickupWakeBudgetPerMin);
  return next;
}

/** The key of the area inside `instance_settings.general`. */
export const TEAM_LIVENESS_SETTINGS_KEY = "teamLiveness";

/**
 * Per-agent switch key on the agent card: `adapterConfig.teamLiveness`.
 *
 * A card carries an opt-out per behaviour; an absent switch means "follow the
 * instance value". The card never carries numbers: the wake budget and the
 * throttle are company-wide ceilings, so a single agent must not be able to
 * raise them (and a card that could would be a bypass of the ceiling).
 */
export const TEAM_LIVENESS_CARD_KEY = "teamLiveness";

export const agentTeamLivenessCardSchema = z
  .object({
    autoResume: z.boolean().optional(),
    runStall: z.boolean().optional(),
    idlePickup: z.boolean().optional(),
  })
  .strict();

export type AgentTeamLivenessCard = z.infer<typeof agentTeamLivenessCardSchema>;

/** The overrides a card carries; an unreadable block reads as "no override". */
export function readAgentTeamLivenessCard(card: Record<string, unknown>): AgentTeamLivenessCard {
  const block = card[TEAM_LIVENESS_CARD_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const parsed = agentTeamLivenessCardSchema.safeParse(block);
  return parsed.success ? parsed.data : {};
}

/** What one agent's three behaviour switches resolve to. */
export interface ResolvedAgentTeamLiveness {
  autoResumeEnabled: boolean;
  runStallEnabled: boolean;
  idlePickupEnabled: boolean;
}

/**
 * The card override, else the instance value. The instance value decides the
 * default for every agent that never touched this block, which is why the
 * resolution takes the resolved instance settings rather than the raw row.
 */
export function resolveAgentTeamLiveness(
  card: Record<string, unknown>,
  settings: TeamLivenessSettings,
): ResolvedAgentTeamLiveness {
  const overrides = readAgentTeamLivenessCard(card);
  return {
    autoResumeEnabled: overrides.autoResume ?? settings.autoResumeEnabled,
    runStallEnabled: overrides.runStall ?? settings.runStallEnabled,
    idlePickupEnabled: overrides.idlePickup ?? settings.idlePickupEnabled,
  };
}
