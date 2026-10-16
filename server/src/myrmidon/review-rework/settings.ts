// server/src/myrmidon/review-rework/settings.ts
//
// myrmidon(REVIEW-REWORK): read and write `instance_settings.general.reviewRework`.
//
// The stored settings are the single source (no environment fallback: the
// executor fallback is an agent id of this instance, which belongs to the
// board, not to a deployment), read on every sweep pass so a change applies
// without a restart — the same rule the review routing and the swarm-claim
// pilot settings follow. An absent or malformed row means the defaults, and
// the defaults are "on": this is a defect fix (CONVENTIONS.md §8).
//
// 1.6.4: like SWARM-SETTINGS-UI, every update appends a capped, newest-first
// journal entry under `general.reviewReworkJournal` so the settings screen can
// answer "who turned this off, and when", and writes the
// `instance.review_rework.updated` activity row.

import type { Db } from "@paperclipai/db";
import {
  REVIEW_REWORK_JOURNAL_KEY,
  REVIEW_REWORK_JOURNAL_LIMIT,
  REVIEW_REWORK_SETTINGS_KEY,
  REVIEW_REWORK_SETTINGS_UPDATED_ACTION,
  mergeReviewReworkSettings,
  normalizeReviewReworkSettings,
  type ReviewReworkSettings,
  type ReviewReworkSettingsPatch,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

/** One journal entry: who changed what, and when. */
export interface ReviewReworkJournalEntry {
  at: string;
  actorType: string;
  actorId: string;
  /** The keys the actor changed, with their new values. */
  patch: ReviewReworkSettingsPatch;
}

export interface ReviewReworkSettingsPorts {
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

export interface ReviewReworkSettingsService {
  read(): Promise<ReviewReworkSettings>;
  update(
    patch: ReviewReworkSettingsPatch,
    actor: { actorType: string; actorId: string },
  ): Promise<ReviewReworkSettings>;
  /** The change journal, newest first; empty when nothing was ever changed. */
  journal(): Promise<ReviewReworkJournalEntry[]>;
}

type GeneralRecord = Record<string, unknown>;

function asGeneral(value: unknown): GeneralRecord {
  return typeof value === "object" && value !== null ? (value as GeneralRecord) : {};
}

function readJournal(raw: unknown): ReviewReworkJournalEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ReviewReworkJournalEntry[] = [];
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
      patch: record.patch as ReviewReworkSettingsPatch,
    });
  }
  return entries;
}

function appendJournal(
  existing: ReviewReworkJournalEntry[],
  entry: ReviewReworkJournalEntry,
): ReviewReworkJournalEntry[] {
  return [entry, ...existing].slice(0, REVIEW_REWORK_JOURNAL_LIMIT);
}

export function reviewReworkSettingsService(
  _db: Db,
  ports: ReviewReworkSettingsPorts,
): ReviewReworkSettingsService {
  async function readGeneral(): Promise<GeneralRecord> {
    return asGeneral(await ports.settings.getGeneral());
  }

  return {
    read: async () => {
      const general = await readGeneral();
      return normalizeReviewReworkSettings(general[REVIEW_REWORK_SETTINGS_KEY]);
    },
    journal: async () => {
      const general = await readGeneral();
      return readJournal(general[REVIEW_REWORK_JOURNAL_KEY]);
    },
    async update(patch, actor) {
      const general = await readGeneral();
      const current = normalizeReviewReworkSettings(general[REVIEW_REWORK_SETTINGS_KEY]);
      const next = mergeReviewReworkSettings(current, patch);
      const entry: ReviewReworkJournalEntry = {
        at: new Date().toISOString(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        patch,
      };
      // One atomic updateGeneral write carries both the settings and the
      // journal entry — they cannot disagree.
      await ports.settings.updateGeneral({
        [REVIEW_REWORK_SETTINGS_KEY]: next,
        [REVIEW_REWORK_JOURNAL_KEY]: appendJournal(
          readJournal(general[REVIEW_REWORK_JOURNAL_KEY]),
          entry,
        ),
      });
      await ports.logActivity?.({
        companyId: "",
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: REVIEW_REWORK_SETTINGS_UPDATED_ACTION,
        entityType: "instance_settings",
        entityId: REVIEW_REWORK_SETTINGS_KEY,
        details: { settings: next, patch },
      });
      return next;
    },
  };
}
