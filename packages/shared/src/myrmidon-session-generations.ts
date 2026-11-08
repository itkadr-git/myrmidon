// myrmidon(PERF-DIET-K): thresholds of the issue-scoped session generations of
// a container bot, shared by the server and the instance-settings validator.
//
// A container bot's task conversation lives in the bot's own Hermes state and is
// addressed by the session key. With `sessionKeyStrategy=issue` (the default)
// that key never changed, so one task's session grew for the task's whole life.
// The board now puts a generation into the key (`...:issue:<iid>:g<N>`) and
// starts a new generation once the current one passes a threshold: more than
// `maxMessages` recorded runs, or older than `maxDays` days. The first
// generation carries no suffix, so nothing changes until a threshold is crossed.
//
// The settings live in `instance_settings.general.sessions` (its own key, not a
// sub-key of anything else). They are read at every run dispatch, so a change
// takes effect without a restart.

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its settings under. */
export const SESSION_GENERATIONS_SETTINGS_KEY = "sessions";

/** Runs (wakes) recorded in one generation; the plan's default. */
export const SESSION_GENERATION_DEFAULT_MAX_MESSAGES = 400;

/** Age of one generation in days; the plan's default. */
export const SESSION_GENERATION_DEFAULT_MAX_DAYS = 14;

const thresholdSchema = z.number().int().min(1).max(1_000_000);

export const sessionGenerationsSettingsSchema = z
  .object({
    /** false turns the feature off: the session key never gains a suffix. */
    enabled: z.boolean(),
    /** A generation that recorded MORE runs than this rolls over. */
    maxMessages: thresholdSchema,
    /** A generation older than this many days rolls over. */
    maxDays: thresholdSchema,
  })
  .strict();

export type SessionGenerationsSettings = z.infer<typeof sessionGenerationsSettingsSchema>;

/** The instance-settings PATCH body: the same shape, every field optional. */
export const patchSessionGenerationsSettingsSchema = sessionGenerationsSettingsSchema.partial();
export type SessionGenerationsSettingsPatch = z.infer<typeof patchSessionGenerationsSettingsSchema>;

/**
 * A lenient view of the stored row: partial, and an unreadable object reads as
 * absent. A strict miss here would fail the whole general block, and the next
 * write would drop every setting of the instance.
 */
export const storedSessionGenerationsSettingsSchema = sessionGenerationsSettingsSchema
  .partial()
  .optional()
  .catch(undefined);
export type StoredSessionGenerationsSettings = z.infer<typeof storedSessionGenerationsSettingsSchema>;

/**
 * The stored settings merged over the plan's defaults. A hand-edited or
 * partially written row keeps the fields it does carry; an unreadable one is
 * the default (the fix stays on, thresholds 400 / 14).
 */
export function normalizeSessionGenerationsSettings(raw: unknown): SessionGenerationsSettings {
  const parsed = storedSessionGenerationsSettingsSchema.safeParse(raw);
  const stored = parsed.success ? (parsed.data ?? {}) : {};
  return {
    enabled: stored.enabled ?? true,
    maxMessages: stored.maxMessages ?? SESSION_GENERATION_DEFAULT_MAX_MESSAGES,
    maxDays: stored.maxDays ?? SESSION_GENERATION_DEFAULT_MAX_DAYS,
  };
}