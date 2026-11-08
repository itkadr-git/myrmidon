// server/src/myrmidon/goal-judge/settings.ts
//
// myrmidon(1.7-GOAL-JUDGE): read and write `instance_settings.general.goalJudge`.
//
// Configures the goal-achievement judge model and its master switch.
// Patterned after review-rework (server/src/myrmidon/review-rework/settings.ts):
// settings stored in instance settings `general.goalJudge`, journal of updates in
// `general.goalJudgeJournal`, and activity log on mutating updates.

import type { Db } from "@myrmidon/db";
import {
  GOAL_JUDGE_JOURNAL_KEY,
  GOAL_JUDGE_JOURNAL_LIMIT,
  GOAL_JUDGE_SETTINGS_KEY,
  GOAL_JUDGE_SETTINGS_UPDATED_ACTION,
  mergeGoalJudgeSettings,
  normalizeGoalJudgeSettings,
  type GoalJudgeSettings,
  type GoalJudgeSettingsPatch,
} from "@myrmidon/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export {
  GOAL_JUDGE_SETTINGS_KEY,
  GOAL_JUDGE_JOURNAL_KEY,
  GOAL_JUDGE_JOURNAL_LIMIT,
  GOAL_JUDGE_SETTINGS_UPDATED_ACTION,
  goalJudgeSettingsSchema,
  patchGoalJudgeSettingsSchema,
  normalizeGoalJudgeSettings,
  mergeGoalJudgeSettings,
  defaultGoalJudgeSettings,
  type GoalJudgeSettings,
  type GoalJudgeSettingsPatch,
} from "@myrmidon/shared";

/** One journal entry: who changed what, and when. */
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
