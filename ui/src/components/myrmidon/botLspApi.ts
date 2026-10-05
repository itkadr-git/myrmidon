// Bot language servers (myrmidon BOT-LSP-DEFAULTS): GET/PATCH /api/myrmidon/bot-lsp.
//
// The instance policy — which roles write code, and the language-server mode
// of coding and non-coding bots — plus the mode every container bot resolves
// to. The profile compiler re-reads the row every reconcile tick; a changed
// mode reaches a bot as a config change applied while that bot is paused.
import type {
  BotLspAgentMode,
  BotLspModeCounts,
  BotLspSettings,
  BotLspSettingsPatch,
  EffectiveBotLspSettings,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export interface BotLspView {
  settings: BotLspSettings;
  effective: EffectiveBotLspSettings;
  agents: BotLspAgentMode[];
  counts: BotLspModeCounts;
}

export const botLspQueryKey = ["myrmidon", "bot-lsp"] as const;

export const botLspApi = {
  get: () => api.get<BotLspView>("/myrmidon/bot-lsp"),
  update: (patch: BotLspSettingsPatch) => api.patch<BotLspView>("/myrmidon/bot-lsp", patch),
};
