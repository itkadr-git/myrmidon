// myrmidon(BOT-ROLLOUT): API client of the release bot-image rollout settings —
// GET/PATCH /api/myrmidon/bot-image-rollout
// (server/src/myrmidon/bot-containers/bot-image-rollout-routes.ts).
import { api } from "@/api/client";
import type { BotImageRolloutSettings, BotImageRolloutSettingsPatch, ResolvedBotImageRolloutSettings } from "@paperclipai/shared";

export interface BotImageRolloutView {
  /** The stored overrides (absent fields come from env / defaults). */
  settings: BotImageRolloutSettings;
  /** The settings in force: each knob resolved env→override, with its source and cap. */
  resolved: ResolvedBotImageRolloutSettings;
}

export const botImageRolloutQueryKey = ["myrmidon", "bot-image-rollout"] as const;

export const botImageRolloutApi = {
  get: () => api.get<BotImageRolloutView>("/myrmidon/bot-image-rollout"),
  patch: (patch: BotImageRolloutSettingsPatch) => api.patch<BotImageRolloutView>("/myrmidon/bot-image-rollout", patch),
};
