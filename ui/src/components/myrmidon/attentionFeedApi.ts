// Attention feed windows (myrmidon 1.6.6 SETTINGS-UI C-4):
// GET/PATCH /api/myrmidon/attention-feed.
//
// GET reports the two windows the attention feed is built with — the failed-run
// horizon in days and the per-company cache TTL in seconds — plus the bounds
// each field accepts and whether the value comes from the stored settings row
// or the built-in default. PATCH saves them to the instance settings and the
// feed picks them up on its next build, without restarting the server.
import { api } from "@/api/client";

export type AttentionFeedLimitSource = "settings" | "default";

export interface AttentionFeedBounds {
  failedRunHorizonDays: { min: number; max: number; default: number };
  feedCacheTtlSeconds: { min: number; max: number; default: number };
}

export interface AttentionFeedView {
  settings: {
    failedRunHorizonDays: number;
    feedCacheTtlSeconds: number;
  };
  sources: {
    failedRunHorizonDays: AttentionFeedLimitSource;
    feedCacheTtlSeconds: AttentionFeedLimitSource;
  };
  bounds: AttentionFeedBounds;
}

export interface AttentionFeedPatch {
  failedRunHorizonDays?: number;
  feedCacheTtlSeconds?: number;
}

export const attentionFeedQueryKey = ["myrmidon", "attention-feed"] as const;

export const attentionFeedApi = {
  get: () => api.get<AttentionFeedView>("/myrmidon/attention-feed"),
  update: (patch: AttentionFeedPatch) => api.patch<AttentionFeedView>("/myrmidon/attention-feed", patch),
};