// packages/shared/src/myrmidon-goal-judge.ts
//
// myrmidon(1.7-GOAL-JUDGE): the shared contract of the goal-achievement judge.
//
// The stop-gate before review asks one question about a finished task: «цель
// достигнута?». The answer is decided by a model call (a *stronger* model than
// the executor's, so the judge does not simply agree with the author), on the
// task's acceptance criteria, the diff and the test output. Three invariants
// shape this contract:
//
//   1. the master switch ships dark — a typo must never start paid model calls
//      (`DEFAULT_GOAL_JUDGE_ENABLED = false`);
//   2. with the switch off the controller makes NO model call at all;
//   3. the call goes to the configured judge provider and model, never to a
//      default — an unconfigured judge is a visible error, not a silent guess.
//
// The settings live in `instance_settings.general.goalJudge`, the change
// journal in `general.goalJudgeJournal` (newest first), patterned after
// review-rework (packages/shared/src/myrmidon-review-rework.ts). The stored
// key is top-level (never a sub-key of a sibling feature's object): a
// sibling's own settings PATCH rewrites its namespace wholesale and would drop
// unknown keys.
//
// The API key of the provider is never part of this contract: `wiring.ts`
// resolves it from the secret store on every call, and it never reaches a log
// line, an error message or an API response.

import { z } from "zod";

/** The `instance_settings.general` key the judge settings are stored under. */
export const GOAL_JUDGE_SETTINGS_KEY = "goalJudge";

/** Journal key of the settings changes, newest first (mirrors `reviewReworkJournal`). */
export const GOAL_JUDGE_JOURNAL_KEY = "goalJudgeJournal";

/** Entries kept in the journal; older ones fall off the front. */
export const GOAL_JUDGE_JOURNAL_LIMIT = 50;

/** The settings-change audit row (mirrors `instance.review_rework.updated`). */
export const GOAL_JUDGE_SETTINGS_UPDATED_ACTION = "instance.goal_judge.updated";

/**
 * Master switch. Ships dark: the judge costs a paid model call per task, so a
 * missing or malformed row must mean "off", and only an explicit
 * `enabled: true` turns it on.
 */
export const DEFAULT_GOAL_JUDGE_ENABLED = false;

/**
 * Temperature of the judge call. Pinned to 0: the same task must get the same
 * verdict, and a creative judge is not a judge.
 */
export const DEFAULT_GOAL_JUDGE_TEMPERATURE = 0;

/** Per-call ceiling of the model request (one round). */
export const DEFAULT_GOAL_JUDGE_TIMEOUT_MS = 60_000;

/**
 * Rounds of the evaluation loop: a non-JSON or incomplete verdict is retried
 * with the previous answer and the reported gaps, up to this cap.
 */
export const DEFAULT_GOAL_JUDGE_MAX_ROUNDS = 3;
export const MIN_GOAL_JUDGE_MAX_ROUNDS = 1;
export const MAX_GOAL_JUDGE_MAX_ROUNDS = 10;

export const goalJudgeSettingsSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_GOAL_JUDGE_ENABLED),
    /**
     * The company model provider the judge calls (`model_providers.id`).
     * `null` means "not configured yet" — with the switch on this is a visible
     * error, never a silent fallback to some other provider.
     */
    providerId: z.string().nullable().default(null),
    /** The model id sent to that provider. `null` means "not configured yet". */
    model: z.string().nullable().default(null),
    temperature: z.number().default(DEFAULT_GOAL_JUDGE_TEMPERATURE),
    timeoutMs: z.number().int().positive().default(DEFAULT_GOAL_JUDGE_TIMEOUT_MS),
    maxRounds: z
      .number()
      .int()
      .min(MIN_GOAL_JUDGE_MAX_ROUNDS)
      .max(MAX_GOAL_JUDGE_MAX_ROUNDS)
      .default(DEFAULT_GOAL_JUDGE_MAX_ROUNDS),
  })
  .strict();

export type GoalJudgeSettings = z.infer<typeof goalJudgeSettingsSchema>;

// Built per-field, not `.partial()` over the settings schema: partial keeps
// the field defaults, so `{}` would validate as a full settings row and slip
// past the refine below.
export const patchGoalJudgeSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    providerId: z.string().min(1).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    temperature: z.number().min(0).max(2).optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxRounds: z
      .number()
      .int()
      .min(MIN_GOAL_JUDGE_MAX_ROUNDS)
      .max(MAX_GOAL_JUDGE_MAX_ROUNDS)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "The settings patch must change at least one key",
  });

export type GoalJudgeSettingsPatch = z.infer<typeof patchGoalJudgeSettingsSchema>;

export interface GoalJudgeJournalEntry {
  at: string;
  actorType: string;
  actorId: string;
  patch: GoalJudgeSettingsPatch;
}

/** The stored settings, or the defaults when absent or unreadable. */
export function normalizeGoalJudgeSettings(raw: unknown): GoalJudgeSettings {
  const parsed = goalJudgeSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return parsed.data;
  }
  // A hand-edited row cannot half-apply: unreadable means the defaults.
  return goalJudgeSettingsSchema.parse({});
}

/** Merge a patch over the current effective settings (PATCH semantics, per key). */
export function mergeGoalJudgeSettings(
  current: GoalJudgeSettings,
  patch: GoalJudgeSettingsPatch,
): GoalJudgeSettings {
  return normalizeGoalJudgeSettings({
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.temperature !== undefined ? { temperature: patch.temperature } : {}),
    ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
    ...(patch.maxRounds !== undefined ? { maxRounds: patch.maxRounds } : {}),
  });
}

/** Defaults object (a fresh copy, safe to hand to a caller). */
export function defaultGoalJudgeSettings(): GoalJudgeSettings {
  return goalJudgeSettingsSchema.parse({});
}
