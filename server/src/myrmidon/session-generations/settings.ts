// server/src/myrmidon/session-generations/settings.ts
//
// myrmidon(PERF-DIET-K): the thresholds of issue-scoped session generations, as
// the run dispatch resolves them.
//
// The stored shape, its key and the plan's defaults live in the shared contract
// (`packages/shared/src/myrmidon-session-generations.ts`), which the
// instance-settings validator uses too, so a PATCH of
// `instance_settings.general.sessions` is accepted and read back here. The row
// is read at every dispatch — like the other myrmidon instance settings
// (`general.botDisk`, `general.botDiskQuota`, `general.agentMemory`) a change
// applies without a restart.
//
// The environment is only a fallback for a value the row does not carry, so a
// deployment can pin a threshold before anyone writes the row.

import {
  SESSION_GENERATION_DEFAULT_MAX_DAYS,
  SESSION_GENERATION_DEFAULT_MAX_MESSAGES,
  SESSION_GENERATIONS_SETTINGS_KEY,
  storedSessionGenerationsSettingsSchema,
} from "@paperclipai/shared";

export { SESSION_GENERATIONS_SETTINGS_KEY };

/** The environment fallback of the enable flag. */
export const SESSION_GENERATIONS_ENV = "MYRMIDON_SESSION_GENERATIONS";
/** The environment fallback of the activity threshold. */
export const SESSION_GENERATIONS_MAX_MESSAGES_ENV = "MYRMIDON_SESSION_GENERATIONS_MAX_MESSAGES";
/** The environment fallback of the age threshold. */
export const SESSION_GENERATIONS_MAX_DAYS_ENV = "MYRMIDON_SESSION_GENERATIONS_MAX_DAYS";

export const DEFAULT_MAX_MESSAGES = SESSION_GENERATION_DEFAULT_MAX_MESSAGES;
export const DEFAULT_MAX_DAYS = SESSION_GENERATION_DEFAULT_MAX_DAYS;

export interface SessionGenerationSettings {
  /** false = the session key never gains a generation suffix (vendor behaviour). */
  enabled: boolean;
  /** A generation of more than this many messages rolls over. */
  maxMessages: number;
  /** A generation older than this many days rolls over. */
  maxDays: number;
}

/** A positive integer from an environment value, or null. */
function readPositiveInt(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/**
 * Truthy/falsy reading of an enable flag, in the fork's usual convention: the
 * fix is on unless the value says otherwise, and only the recognized off values
 * turn it off — a typo never silently disables a fix.
 */
export function readSessionGenerationsEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return true;
  const raw = value.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

/**
 * The thresholds in force. `stored` is `instance_settings.general.sessions`,
 * `env` the board's process environment. A stored value wins over the
 * environment; an unreadable one falls through to the next source, and when
 * nothing carries a value the plan's default applies. Turning the feature off
 * needs an explicit off: the stored flag, then the environment one.
 */
export function resolveSessionGenerationSettings(input: {
  stored?: unknown;
  env?: NodeJS.ProcessEnv;
} = {}): SessionGenerationSettings {
  const parsed = storedSessionGenerationsSettingsSchema.safeParse(input.stored);
  const stored = parsed.success ? (parsed.data ?? {}) : {};
  const env = input.env ?? process.env;
  return {
    // The stored flag wins; the environment one applies when the row says
    // nothing (see the SETTINGS row of this feature).
    enabled: stored.enabled ?? readSessionGenerationsEnabled(env[SESSION_GENERATIONS_ENV]),
    maxMessages:
      stored.maxMessages ??
      readPositiveInt(env[SESSION_GENERATIONS_MAX_MESSAGES_ENV]) ??
      DEFAULT_MAX_MESSAGES,
    maxDays:
      stored.maxDays ??
      readPositiveInt(env[SESSION_GENERATIONS_MAX_DAYS_ENV]) ??
      DEFAULT_MAX_DAYS,
  };
}