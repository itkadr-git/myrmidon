// Discussion rooms on issue cards (myrmidon 1.7 AGENT-EXCHANGE-A):
// GET/PATCH /api/myrmidon/agent-exchange/settings.
//
// The room rules: 2–4 participants on different models answer independently,
// rounds are capped, the token budget stops the room, and the owner holds the
// stop valve. PATCH saves to the instance settings and applies at the next
// room open, without restarting the server. Every value shows its source —
// the saved settings, the server environment, or the default.
import type {
  AgentExchangeSettingsPatch,
  AgentExchangeSettingSource,
  ResolvedAgentExchangeSettings,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export type AgentExchangeSettingsView = ResolvedAgentExchangeSettings;

export const agentExchangeQueryKey = ["myrmidon", "agent-exchange"] as const;

export const agentExchangeApi = {
  get: () => api.get<AgentExchangeSettingsView>("/myrmidon/agent-exchange/settings"),
  update: (patch: AgentExchangeSettingsPatch) =>
    api.patch<AgentExchangeSettingsView>("/myrmidon/agent-exchange/settings", patch),
};

export function describeAgentExchangeSource(source: AgentExchangeSettingSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Forced by the server environment";
    default:
      return "Default";
  }
}
