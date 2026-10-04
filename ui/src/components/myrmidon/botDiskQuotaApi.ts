// Bot API client (1.6.1-BOT-DISK-C): the per-bot disk quota of the instance.
import { api } from "@/api/client";
import type {
  BotDiskQuotaSettings,
  BotDiskQuotaSettingsPatch,
} from "@paperclipai/shared";

export interface BotDiskQuotaSweepView {
  at: string;
  scanned: number;
  measured: number;
  skippedNoQuota: number;
  failed: number;
  signalling: number;
  elapsedMs: number;
}

export interface BotDiskQuotaView {
  settings: BotDiskQuotaSettings;
  lastSweep: BotDiskQuotaSweepView | null;
}

export const botDiskQuotaQueryKey = ["myrmidon", "bot-disk-quota"] as const;

export const botDiskQuotaApi = {
  get: () => api.get<BotDiskQuotaView>("/myrmidon/bot-disk-quota"),
  patch: (patch: BotDiskQuotaSettingsPatch) =>
    api.patch<BotDiskQuotaView>("/myrmidon/bot-disk-quota", patch),
};
