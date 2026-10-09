// packages/shared/src/myrmidon-long-task-context.ts
//
// myrmidon(1.6.6 LONG-TASK-CONTEXT): the shared contract of the long-task
// context guard — the settings that keep an ever-running task (a task whose
// thread has no end date) from pushing a run past the model's context window,
// where the runtime's own compression gives up and the agent lands in `error`.
//
// The settings live in `instance_settings.general.longTaskContext` and change
// live (no restart): every pass re-reads them. The shape:
//
//   - resetPct is the share of the model's input window at which the board
//     stops resuming the task's accumulated session and starts the next run
//     from the continuation summary instead. The reset happens BEFORE the
//     window is reached ("compress up to the threshold, not after"), which is
//     the whole point: the runtime's compression is what times out;
//   - fallbackWindowTokens is the window the percentage counts against when
//     the agent's model has no known `maxInputTokens` (the same documented
//     fallback the prompt-budget settings use);
//   - historyChars bounds the VOLUME of task history a launch payload carries:
//     older comments stay readable through the issue API instead of travelling
//     with every run of an ever-running task;
//   - enabled = false reports the pressure but never resets a session.
//
// The stored row is the single truth: an absent or malformed row normalizes to
// the defaults (enabled, reset at 80%, 200k fallback window, 24k history
// budget), so a hand-edited row can never half-apply.

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its settings under. */
export const LONG_TASK_CONTEXT_SETTINGS_KEY = "longTaskContext";

/** The default reset threshold, percent of the model's input window. */
export const LONG_TASK_CONTEXT_DEFAULT_RESET_PCT = 80;

/**
 * The window the percentage counts against when the agent's model has no known
 * `maxInputTokens`. Matches the prompt-budget fallback: the fleet's long-context
 * cards sit around 200k, and an operator with smaller windows lowers it.
 */
export const LONG_TASK_CONTEXT_DEFAULT_FALLBACK_WINDOW_TOKENS = 200_000;

/** The default volume budget of task history in one launch payload, characters. */
export const LONG_TASK_CONTEXT_DEFAULT_HISTORY_CHARS = 24_000;

/** Body of `PUT .../long-task-context/settings` — the full settings object. */
export const longTaskContextSettingsSchema = z
  .object({
    /** false = the feature reports the pressure but never resets a session. */
    enabled: z.boolean(),
    /** Reset threshold, percent of the model window. */
    resetPct: z.number().int().min(1).max(99),
    /** The window used when the agent's model is unknown to litellm_models. */
    fallbackWindowTokens: z.number().int().min(1000).max(100_000_000),
    /** Volume budget of one launch payload's task history, characters. */
    historyChars: z.number().int().min(2_000).max(1_000_000),
  })
  .strict();

export type LongTaskContextSettings = z.infer<typeof longTaskContextSettingsSchema>;

export const LONG_TASK_CONTEXT_SETTING_KEYS = [
  "enabled",
  "resetPct",
  "fallbackWindowTokens",
  "historyChars",
] as const;

export type LongTaskContextSettingKey = (typeof LONG_TASK_CONTEXT_SETTING_KEYS)[number];

/** The settings the feature runs on when nothing (usable) is stored. */
export function defaultLongTaskContextSettings(): LongTaskContextSettings {
  return {
    enabled: true,
    resetPct: LONG_TASK_CONTEXT_DEFAULT_RESET_PCT,
    fallbackWindowTokens: LONG_TASK_CONTEXT_DEFAULT_FALLBACK_WINDOW_TOKENS,
    historyChars: LONG_TASK_CONTEXT_DEFAULT_HISTORY_CHARS,
  };
}

/** True when a stored row parses — the difference between "stored" and "default". */
export function isUsableLongTaskContextSettings(raw: unknown): boolean {
  return longTaskContextSettingsSchema.safeParse(raw).success;
}

/** The settings as stored, or the defaults when absent or unreadable. */
export function normalizeLongTaskContextSettings(raw: unknown): LongTaskContextSettings {
  const parsed = longTaskContextSettingsSchema.safeParse(raw);
  if (parsed.success) return { ...parsed.data };
  // A hand-edited row cannot half-apply: an unreadable object is the default
  // set, so the guard never resets sessions off corrupt thresholds.
  return defaultLongTaskContextSettings();
}

/** The share of the window a prompt total takes, in percent (one decimal). */
export function longTaskContextPct(total: number, windowTokens: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(windowTokens) || windowTokens <= 0) return 0;
  return Math.round((total / windowTokens) * 1000) / 10;
}

/**
 * The reset decision: drop the accumulated task session before this launch
 * when the task's own last prompt already sits at or above the threshold.
 *
 * A task with no measured prompt (`promptTotal` null) is never reset — there is
 * nothing to be over the window yet.
 */
export function shouldResetTaskSessionForLongTaskContext(input: {
  settings: Pick<LongTaskContextSettings, "enabled" | "resetPct">;
  promptTotal: number | null;
  windowTokens: number;
}): boolean {
  if (!input.settings.enabled) return false;
  if (input.promptTotal === null) return false;
  if (!Number.isFinite(input.promptTotal) || input.promptTotal <= 0) return false;
  if (!Number.isFinite(input.windowTokens) || input.windowTokens <= 0) return false;
  return longTaskContextPct(input.promptTotal, input.windowTokens) >= input.settings.resetPct;
}