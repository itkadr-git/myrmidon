// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): manual update availability API client
import { api } from "@/api/client";
import type { CheckUpdatesRequest, CheckUpdatesResponse } from "@myrmidon/shared";

export const checkUpdatesQueryKey = ["system", "check-updates"] as const;

export const checkUpdatesApi = {
  get: (channel?: string) =>
    api.get<CheckUpdatesResponse>(
      channel
        ? `/system/check-updates?channel=${encodeURIComponent(channel)}`
        : "/system/check-updates",
    ),
  check: (input?: CheckUpdatesRequest) =>
    api.post<CheckUpdatesResponse>("/system/check-updates", input ?? {}),
};
