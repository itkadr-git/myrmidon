import { z } from "zod";

/**
 * Foraging settings and spend limits (myrmidon 1.6.1, FORAGING-LIMITS-UI).
 *
 * Foraging (the source-comparison sweep, 1.6-FORAGE) was switchable only
 * through the environment, which meant a restart, and its per-pass budget was
 * its only ceiling. The owner's 03.10 decision: the enable switch, the pass
 * tuning and the spend limits belong in the interface in 1.6.1 — before the
 * general budget hierarchy of BUDGET-CONFIG (1.7). This module is the shared
 * contract of that change, in the same shape RUNTIME-LIMITS and
 * SWARM-SETTINGS-UI use:
 *
 * - the stored settings value, when `general.foraging` holds a value the
 *   validator accepts (UI → `PATCH /api/myrmidon/foraging-settings`);
 * - for each key separately, a set and readable environment variable wins
 *   over the stored value (the deployment's forced override);
 * - otherwise the built-in default.
 *
 * `null` on a limit means "no limit". A limit is a positive integer number of
 * cents, so nothing here can turn a ceiling into "spend one cent anyway".
 *
 * The spend limits are: a per-pass budget (the old
 * `MYRMIDON_FORAGING_BUDGET_CENTS`), a per-company daily and monthly ceiling,
 * and per-role and per-agent ceilings. When a pass would cross a ceiling it
 * stops (`stopped_by_budget` on the pass, the sources after the stop stay
 * untouched); `enforcement: "soft"` additionally raises one attention signal
 * asking the owner whether to continue.
 */

/** Environment variable per value — the names the foraging module reads. */
export const FORAGING_SETTINGS_ENV_KEYS = {
  enabled: "MYRMIDON_FORAGING_ENABLED",
  intervalSec: "MYRMIDON_FORAGING_INTERVAL_SEC",
  minHostIntervalSec: "MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC",
  passBudgetCents: "MYRMIDON_FORAGING_BUDGET_CENTS",
  dailyBudgetCents: "MYRMIDON_FORAGING_DAILY_BUDGET_CENTS",
  monthlyBudgetCents: "MYRMIDON_FORAGING_MONTHLY_BUDGET_CENTS",
  roleBudgetCents: "MYRMIDON_FORAGING_ROLE_BUDGET_CENTS",
  agentBudgetCents: "MYRMIDON_FORAGING_AGENT_BUDGET_CENTS",
} as const;

/** The foraging per-pass budget env key, kept for the old module's exports. */
export const FORAGING_BUDGET_CENTS_ENV = FORAGING_SETTINGS_ENV_KEYS.passBudgetCents;
export const FORAGING_INTERVAL_SEC_ENV = FORAGING_SETTINGS_ENV_KEYS.intervalSec;

export const FORAGING_SETTING_KEYS = [
  "enabled",
  "intervalSec",
  "minHostIntervalSec",
  "passBudgetCents",
  "dailyBudgetCents",
  "monthlyBudgetCents",
  "roleBudgetCents",
  "agentBudgetCents",
  "enforcement",
  "autoOffCostPerTaskCents",
] as const;

export type ForagingSettingKey = (typeof FORAGING_SETTING_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type ForagingSettingsSource = "settings" | "env" | "default";

/**
 * Stored-settings key inside `instance_settings.general` that holds the whole
 * object — one key, like `runLimits` and `swarmClaim`, so a partial
 * hand-edited row cannot silently enable the sweep.
 */
export const FORAGING_SETTINGS_KEY = "foraging";

/** Master switch. Off unless the exact value `1` (or true in settings) turns it on: a typo cannot start reads. */
export const DEFAULT_FORAGING_ENABLED = false;

/** Period of the pass, in seconds. */
export const DEFAULT_FORAGING_INTERVAL_SEC = 3600;
export const MIN_FORAGING_INTERVAL_SEC = 60;
export const MAX_FORAGING_INTERVAL_SEC = 86_400;

/** The smallest pause between two reads of the same host, in seconds. */
export const DEFAULT_FORAGING_MIN_HOST_INTERVAL_SEC = 60;
export const MIN_FORAGING_MIN_HOST_INTERVAL_SEC = 5;

/**
 * Ceiling of the cost estimate of ONE pass, in cents. `null` means "no
 * per-pass limit" (the old `0`/negative env reading).
 */
export const DEFAULT_FORAGING_PASS_BUDGET_CENTS = 50;

/** Per-company daily ceiling, in cents; `null` means no daily ceiling. */
export const DEFAULT_FORAGING_DAILY_BUDGET_CENTS: number | null = null;
/** Per-company monthly ceiling, in cents; `null` means no monthly ceiling. */
export const DEFAULT_FORAGING_MONTHLY_BUDGET_CENTS: number | null = null;
/** Per-role ceiling per day, in cents; `null` means no role ceiling. */
export const DEFAULT_FORAGING_ROLE_BUDGET_CENTS: number | null = null;
/** Per-agent ceiling per day, in cents; `null` means no agent ceiling. */
export const DEFAULT_FORAGING_AGENT_BUDGET_CENTS: number | null = null;

/**
 * What happens when a ceiling is reached. `hard` — the pass stops and the
 * signal says so; `soft` — the pass stops the same way (spend is never
 * exceeded), but the signal asks the owner to raise the limit or disable
 * learning. The stop itself never depends on the mode.
 */
export const FORAGING_ENFORCEMENT_MODES = ["hard", "soft"] as const;
export type ForagingEnforcement = (typeof FORAGING_ENFORCEMENT_MODES)[number];
export const DEFAULT_FORAGING_ENFORCEMENT: ForagingEnforcement = "hard";
export const FORAGING_ENFORCEMENT_ENV = "MYRMIDON_FORAGING_ENFORCEMENT";

/**
 * Auto-off threshold (owner's 29.09 addition): when the BASELINE cost-per-task
 * mean rises above this many cents, foraging switches itself off and raises a
 * signal. `null` means the auto-off check is off.
 */
export const DEFAULT_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS: number | null = null;
export const FORAGING_AUTO_OFF_COST_PER_TASK_ENV = "MYRMIDON_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS";

// --- schemas ---------------------------------------------------------------

const intervalSchema = z
  .number()
  .int()
  .min(MIN_FORAGING_INTERVAL_SEC)
  .max(MAX_FORAGING_INTERVAL_SEC);
const minHostIntervalSchema = z.number().int().min(MIN_FORAGING_MIN_HOST_INTERVAL_SEC);
/** A spend ceiling in cents: a positive integer, or null for "no limit". */
const budgetCentsSchema = z.number().int().positive().nullable();

/** The canonical stored shape of `instance_settings.general.foraging`. */
export const foragingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    intervalSec: intervalSchema,
    minHostIntervalSec: minHostIntervalSchema,
    passBudgetCents: budgetCentsSchema,
    dailyBudgetCents: budgetCentsSchema,
    monthlyBudgetCents: budgetCentsSchema,
    roleBudgetCents: budgetCentsSchema,
    agentBudgetCents: budgetCentsSchema,
    enforcement: z.enum(FORAGING_ENFORCEMENT_MODES),
    autoOffCostPerTaskCents: budgetCentsSchema,
  })
  .strict();

/** Body of `PATCH /api/myrmidon/foraging-settings`: any subset; absent keys keep their value. */
export const patchForagingSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalSec: intervalSchema.optional(),
    minHostIntervalSec: minHostIntervalSchema.optional(),
    passBudgetCents: budgetCentsSchema.optional(),
    dailyBudgetCents: budgetCentsSchema.optional(),
    monthlyBudgetCents: budgetCentsSchema.optional(),
    roleBudgetCents: budgetCentsSchema.optional(),
    agentBudgetCents: budgetCentsSchema.optional(),
    enforcement: z.enum(FORAGING_ENFORCEMENT_MODES).optional(),
    autoOffCostPerTaskCents: budgetCentsSchema.optional(),
  })
  .strict();

export type ForagingSettings = z.infer<typeof foragingSettingsSchema>;
export type ForagingSettingsPatch = z.infer<typeof patchForagingSettingsSchema>;

export interface ResolvedForagingSettings {
  settings: ForagingSettings;
  sources: Record<ForagingSettingKey, ForagingSettingsSource>;
}

/** The single truth for "is this string an explicit on?". A typo must not enable the sweep. */
export function parseForagingEnabled(raw: string | undefined | null): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off" || value === "no") return false;
  return null;
}

/** An env budget value: a positive integer of cents, or null for "no limit". */
export function parseForagingBudgetCents(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  // The historical reading of the pass budget: 0 or negative is the explicit
  // "no limit". The same leniency applies to every other ceiling here, so an
  // operator copy-pasting the old convention does not get a silent 1-cent cap.
  if (value <= 0) return null;
  return Math.floor(value);
}

function parseEnforcement(raw: string | undefined): ForagingEnforcement {
  const value = raw?.trim().toLowerCase();
  return value === "soft" ? "soft" : DEFAULT_FORAGING_ENFORCEMENT;
}

/** The settings as the environment declares them, with the built-in defaults. */
export function readForagingSettingsFromEnv(env: Record<string, string | undefined> = {}): ForagingSettings {
  const intervalSec = Number(env[FORAGING_SETTINGS_ENV_KEYS.intervalSec]?.trim());
  const minHostIntervalSec = Number(env[FORAGING_SETTINGS_ENV_KEYS.minHostIntervalSec]?.trim());
  return {
    enabled:
      parseForagingEnabled(env[FORAGING_SETTINGS_ENV_KEYS.enabled]) ?? DEFAULT_FORAGING_ENABLED,
    intervalSec:
      Number.isInteger(intervalSec) &&
      intervalSec >= MIN_FORAGING_INTERVAL_SEC &&
      intervalSec <= MAX_FORAGING_INTERVAL_SEC
        ? intervalSec
        : DEFAULT_FORAGING_INTERVAL_SEC,
    minHostIntervalSec:
      Number.isInteger(minHostIntervalSec) && minHostIntervalSec >= MIN_FORAGING_MIN_HOST_INTERVAL_SEC
        ? minHostIntervalSec
        : DEFAULT_FORAGING_MIN_HOST_INTERVAL_SEC,
    passBudgetCents:
      parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.passBudgetCents]) ??
      DEFAULT_FORAGING_PASS_BUDGET_CENTS,
    dailyBudgetCents:
      parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.dailyBudgetCents]) ??
      DEFAULT_FORAGING_DAILY_BUDGET_CENTS,
    monthlyBudgetCents:
      parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.monthlyBudgetCents]) ??
      DEFAULT_FORAGING_MONTHLY_BUDGET_CENTS,
    roleBudgetCents:
      parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.roleBudgetCents]) ??
      DEFAULT_FORAGING_ROLE_BUDGET_CENTS,
    agentBudgetCents:
      parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.agentBudgetCents]) ??
      DEFAULT_FORAGING_AGENT_BUDGET_CENTS,
    enforcement: parseEnforcement(env[FORAGING_ENFORCEMENT_ENV]),
    autoOffCostPerTaskCents:
      parseForagingBudgetCents(env[FORAGING_AUTO_OFF_COST_PER_TASK_ENV]) ??
      DEFAULT_FORAGING_AUTO_OFF_COST_PER_TASK_CENTS,
  };
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeForagingSettings(raw: unknown): ForagingSettings | null {
  const parsed = foragingSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective settings and where each value came from. `stored` is the raw
 * `general.foraging` value; an unreadable one counts as absent, so the
 * environment (or the default) applies instead — a hand-edited row cannot
 * enable the sweep on its own.
 *
 * 1.6.1 (FORAGING-LIMITS-UI): precedence is per key — the environment
 * variable wins over the stored value only for the keys whose variable is
 * actually set and readable, so the UI stays the source of truth for
 * everything the operator did not force. Each entry of `sources` says which
 * side won for that key (the settings screen renders exactly that).
 */
export function resolveForagingSettings(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedForagingSettings {
  const env = options.env ?? {};
  const stored = normalizeForagingSettings(options.stored);
  const envSettings = readForagingSettingsFromEnv(env);
  const settings: ForagingSettings = stored
    ? {
        ...envSettings,
        ...stored,
        // A set, readable override beats the stored value key by key.
        enabled:
          parseForagingEnabled(env[FORAGING_SETTINGS_ENV_KEYS.enabled]) ?? stored.enabled,
        intervalSec: envIntOr(
          env[FORAGING_SETTINGS_ENV_KEYS.intervalSec],
          stored.intervalSec,
          MIN_FORAGING_INTERVAL_SEC,
          MAX_FORAGING_INTERVAL_SEC,
        ),
        minHostIntervalSec: envIntOr(
          env[FORAGING_SETTINGS_ENV_KEYS.minHostIntervalSec],
          stored.minHostIntervalSec,
          MIN_FORAGING_MIN_HOST_INTERVAL_SEC,
        ),
        passBudgetCents:
          parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.passBudgetCents]) ??
          stored.passBudgetCents,
        dailyBudgetCents:
          parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.dailyBudgetCents]) ??
          stored.dailyBudgetCents,
        monthlyBudgetCents:
          parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.monthlyBudgetCents]) ??
          stored.monthlyBudgetCents,
        roleBudgetCents:
          parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.roleBudgetCents]) ??
          stored.roleBudgetCents,
        agentBudgetCents:
          parseForagingBudgetCents(env[FORAGING_SETTINGS_ENV_KEYS.agentBudgetCents]) ??
          stored.agentBudgetCents,
        enforcement:
          env[FORAGING_ENFORCEMENT_ENV]?.trim() === "soft"
            ? "soft"
            : env[FORAGING_ENFORCEMENT_ENV]?.trim() === "hard"
              ? "hard"
              : stored.enforcement,
        autoOffCostPerTaskCents:
          parseForagingBudgetCents(env[FORAGING_AUTO_OFF_COST_PER_TASK_ENV]) ??
          stored.autoOffCostPerTaskCents,
      }
    : envSettings;

  // The source of each key: the override won ("env"), the stored row won
  // ("settings"), or nothing was set and the built-in default applied
  // ("default").
  const hasOverride = (name: string) => env[name] !== undefined && env[name]!.trim() !== "";
  const sources = {} as Record<ForagingSettingKey, ForagingSettingsSource>;
  for (const key of FORAGING_SETTING_KEYS) {
    const name =
      key === "enforcement"
        ? FORAGING_ENFORCEMENT_ENV
        : key === "autoOffCostPerTaskCents"
          ? FORAGING_AUTO_OFF_COST_PER_TASK_ENV
          : (FORAGING_SETTINGS_ENV_KEYS as Record<string, string>)[key];
    sources[key] = hasOverride(name) ? "env" : stored ? "settings" : "default";
  }
  return { settings, sources };
}

/** A readable integer in range wins; anything else falls back to `stored`. */
function envIntOr(
  raw: string | undefined,
  stored: number,
  min: number,
  max?: number,
): number {
  if (raw === undefined || raw.trim() === "") return stored;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min) return stored;
  if (max !== undefined && value > max) return stored;
  return value;
}

/** A patch over the effective values, the shape that gets stored. */
export function mergeForagingSettings(base: ForagingSettings, patch: ForagingSettingsPatch): ForagingSettings {
  return {
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    intervalSec: patch.intervalSec === undefined ? base.intervalSec : patch.intervalSec,
    minHostIntervalSec:
      patch.minHostIntervalSec === undefined ? base.minHostIntervalSec : patch.minHostIntervalSec,
    passBudgetCents: patch.passBudgetCents === undefined ? base.passBudgetCents : patch.passBudgetCents,
    dailyBudgetCents: patch.dailyBudgetCents === undefined ? base.dailyBudgetCents : patch.dailyBudgetCents,
    monthlyBudgetCents:
      patch.monthlyBudgetCents === undefined ? base.monthlyBudgetCents : patch.monthlyBudgetCents,
    roleBudgetCents: patch.roleBudgetCents === undefined ? base.roleBudgetCents : patch.roleBudgetCents,
    agentBudgetCents: patch.agentBudgetCents === undefined ? base.agentBudgetCents : patch.agentBudgetCents,
    enforcement: patch.enforcement === undefined ? base.enforcement : patch.enforcement,
    autoOffCostPerTaskCents:
      patch.autoOffCostPerTaskCents === undefined
        ? base.autoOffCostPerTaskCents
        : patch.autoOffCostPerTaskCents,
  };
}
