// Shared package cache of development bots (myrmidon 1.6.1-BOT-DISK-B):
// GET/PATCH /api/myrmidon/bot-disk.
//
// GET reports the stored cache path (null: no shared cache). PATCH saves it to
// the instance settings (instance admins only); it applies on the next
// reconcile pass, without restarting the server.
import { api } from "@/api/client";

export interface BotDiskView {
  sharedPackageCachePath: string | null;
}

export const botDiskQueryKey = ["myrmidon", "bot-disk"] as const;

export const botDiskApi = {
  get: () => api.get<BotDiskView>("/myrmidon/bot-disk"),
  update: (patch: BotDiskView) => api.patch<BotDiskView>("/myrmidon/bot-disk", patch),
};
