// Live progress steps in the bridged Telegram DM status message (myrmidon
// DM-PROGRESS): GET/PATCH /api/myrmidon/telegram-dm-progress.
//
// PATCH saves to the instance settings; the next status sweep uses it, without
// restarting the server.
import type {
  ResolvedTelegramDmProgress,
  TelegramDmProgressPatch,
  TelegramDmProgressSource,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export type TelegramDmProgressView = ResolvedTelegramDmProgress;

export const telegramDmProgressQueryKey = ["myrmidon", "telegram-dm-progress"] as const;

export const telegramDmProgressApi = {
  get: () => api.get<TelegramDmProgressView>("/myrmidon/telegram-dm-progress"),
  update: (patch: TelegramDmProgressPatch) =>
    api.patch<TelegramDmProgressView>("/myrmidon/telegram-dm-progress", patch),
};

export function describeTelegramDmProgressSource(source: TelegramDmProgressSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Forced by the server environment";
    default:
      return "Default";
  }
}
