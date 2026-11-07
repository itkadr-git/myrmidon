// server/src/myrmidon/goal-judge/settings.ts
//
// myrmidon(1.7-GOAL-JUDGE): read and write `instance_settings.general.goalJudge`.
//
// Configures the goal-achievement judge model and its master switch.
// Patterned after review-rework (server/src/myrmidon/review-rework/settings.ts):
// settings stored in instance settings `general.goalJudge`, journal of updates in
// `general.goalJudgeJournal`, and activity log on mutating updates.

import { z } from "zod";
import type { Db } from "@myrmidon/db";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export const GOAL_JUDGE_SETTINGS_KEY = "goalJudge";
export const GOAL_JUDGE_JOURNAL_KEY = "goalJudgeJournal";
export const GOAL_JUDGE_JOURNAL_LIMIT = 50;
export const GOAL_JUDGE_SETTINGS_UPDATED_ACTION = "instance.goal_judge.updated";

export const DEFAULT_GOAL_JUDGE_ENABLED = false;
export const DEFAULT_GOAL_JUDGE_TEMPERATURE = 0;
export const DEFAULT_GOAL_JUDGE_TIMEOUT_MS = 60_000;
export const DEFAULT_GOAL_JUDGE_MAX_ROUNDS = 3;

export const goalJudgeSettingsSchema = z.object({
  enabled: z.boolean().default(DEFAULT_GOAL_JUDGE_ENABLED),
  providerId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  temperature: z.number().default(DEFAULT_GOAL_JUDGE_TEMPERATURE),
  timeoutMs: z.number().int().positive().default(DEFAULT_GOAL_JUDGE_TIMEOUT_MS),
  maxRounds: z.number().int().positive().default(DEFAULT_GOAL_JUDGE_MAX_ROUNDS),
});

export type GoalJudgeSettings = z.infer<typeof goalJudgeSettingsSchema>;

export const DEFAULT_GOAL_JUDGE_SETTINGS: GoalJudgeSettings = {
  enabled: DEFAULT_GOAL_JUDGE_ENABLED,
  providerId: null,
  model: null,
  temperature: DEFAULT_GOAL_JUDGE_TEMPERATURE,
  timeoutMs: DEFAULT_GOAL_JUDGE_TIMEOUT_MS,
  maxRounds: DEFAULT_GOAL_JUDGE_MAX_ROUNDS,
};

export const patchGoalJudgeSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  providerId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  temperature: z.number().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRounds: z.number().int().positive().optional(),
});

export type GoalJudgeSettingsPatch = z.infer<typeof patchGoalJudgeSettingsSchema>;

export interface GoalJudgeJournalEntry {
  at: string;
  actorType: string;
  actorId: string;
  patch: GoalJudgeSettingsPatch;
}

export interface GoalJudgeSettingsPorts {
  settings: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral" | "updateGeneral">;
  logActivity?: (input: {
    companyId: string;
    actorType: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
}

export interface GoalJudgeSettingsService {
  read(): Promise<GoalJudgeSettings>;
  update(
    patch: GoalJudgeSettingsPatch,
    actor: { actorType: string; actorId: string },
  ): Promise<GoalJudgeSettings>;
  journal(): Promise<GoalJudgeJournalEntry[]>;
}

type GeneralRecord = Record<string, unknown>;

function asGeneral(value: unknown): GeneralRecord {
  return typeof value === "object" && value !== null ? (value as GeneralRecord) : {};
}

export function normalizeGoalJudgeSettings(raw: unknown): GoalJudgeSettings {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_GOAL_JUDGE_SETTINGS };
  }
  const parsed = goalJudgeSettingsSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  return { ...DEFAULT_GOAL_JUDGE_SETTINGS };
}

export function mergeGoalJudgeSettings(
  current: GoalJudgeSettings,
  patch: GoalJudgeSettingsPatch,
): GoalJudgeSettings {
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    providerId: patch.providerId !== undefined ? patch.providerId : current.providerId,
    model: patch.model !== undefined ? patch.model : current.model,
    temperature: patch.temperature !== undefined ? patch.temperature : current.temperature,
    timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeoutMs,
    maxRounds: patch.maxRounds !== undefined ? patch.maxRounds : current.maxRounds,
  };
}

function readJournal(raw: unknown): GoalJudgeJournalEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: GoalJudgeJournalEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as GeneralRecord;
    if (
      typeof record.at !== "string" ||
      typeof record.actorType !== "string" ||
      typeof record.actorId !== "string" ||
      typeof record.patch !== "object" ||
      record.patch === null
    ) {
      continue;
    }
    entries.push({
      at: record.at,
      actorType: record.actorType,
      actorId: record.actorId,
      patch: record.patch as GoalJudgeSettingsPatch,
    });
  }
  return entries;
}

function appendJournal(
  existing: GoalJudgeJournalEntry[],
  entry: GoalJudgeJournalEntry,
): GoalJudgeJournalEntry[] {
  return [entry, ...existing].slice(0, GOAL_JUDGE_JOURNAL_LIMIT);
}

export function goalJudgeSettingsService(
  _db: Db | null,
  ports: GoalJudgeSettingsPorts,
): GoalJudgeSettingsService {
  async function readGeneral(): Promise<GeneralRecord> {
    return asGeneral(await ports.settings.getGeneral());
  }

  return {
    read: async () => {
      const general = await readGeneral();
      return normalizeGoalJudgeSettings(general[GOAL_JUDGE_SETTINGS_KEY]);
    },
    journal: async () => {
      const general = await readGeneral();
      return readJournal(general[GOAL_JUDGE_JOURNAL_KEY]);
    },
    async update(patch, actor) {
      const general = await readGeneral();
      const current = normalizeGoalJudgeSettings(general[GOAL_JUDGE_SETTINGS_KEY]);
      const next = mergeGoalJudgeSettings(current, patch);
      const entry: GoalJudgeJournalEntry = {
        at: new Date().toISOString(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        patch,
      };

      await ports.settings.updateGeneral({
        [GOAL_JUDGE_SETTINGS_KEY]: next,
        [GOAL_JUDGE_JOURNAL_KEY]: appendJournal(
          readJournal(general[GOAL_JUDGE_JOURNAL_KEY]),
          entry,
        ),
      });

      await ports.logActivity?.({
        companyId: "",
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: GOAL_JUDGE_SETTINGS_UPDATED_ACTION,
        entityType: "instance_settings",
        entityId: GOAL_JUDGE_SETTINGS_KEY,
        details: { settings: next, patch },
      });

      return next;
    },
  };
}
