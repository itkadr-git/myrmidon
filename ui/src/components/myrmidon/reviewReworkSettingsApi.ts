// Review-rework loop settings (myrmidon 1.6.4, REVIEW-REWORK):
// GET/PATCH /api/myrmidon/review-rework.
//
// The switch and the executor a rework task falls to when neither the review
// stage's return assignee nor the delivering task names one. The sweep
// re-reads the stored row on every pass, so saving applies without a restart.
// A null fallback means "no fallback assignee": the rework task is created
// unassigned in todo — the role-queue shape the swarm claims.
import type { ReviewReworkSettings, ReviewReworkSettingsPatch } from "@paperclipai/shared";
import { api } from "@/api/client";

/** One journal entry: who changed what, and when. */
export interface ReviewReworkJournalEntry {
  at: string;
  actorType: string;
  actorId: string;
  patch: ReviewReworkSettingsPatch;
}

export interface ReviewReworkSettingsView {
  settings: ReviewReworkSettings;
  /** The change journal, newest first. */
  journal: ReviewReworkJournalEntry[];
}

export const reviewReworkSettingsQueryKey = ["myrmidon", "review-rework", "settings"] as const;

export const reviewReworkSettingsApi = {
  get: () => api.get<ReviewReworkSettingsView>("/myrmidon/review-rework"),
  update: (patch: ReviewReworkSettingsPatch) =>
    api.patch<ReviewReworkSettingsView>("/myrmidon/review-rework", patch),
};
