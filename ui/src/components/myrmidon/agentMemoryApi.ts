// Agent memory (myrmidon MEMORY-UI): GET/PATCH /api/myrmidon/agent-memory.
//
// The memory service address, the optional key secret name and the switch behind
// the agent card Memory tab. The server re-reads them on every request, so a
// change applies without a restart.
import type { AgentMemorySettings, PatchAgentMemorySettings } from "@paperclipai/shared";
import { api } from "@/api/client";

export interface AgentMemorySettingsView {
  settings: AgentMemorySettings;
  effective: {
    enabled: boolean;
    apiUrl: string | null;
    urlSource: "setting" | "env" | "bot-env" | null;
    keySecretName: string | null;
  };
}

export const agentMemoryQueryKey = ["myrmidon", "agent-memory"] as const;

export const agentMemoryApi = {
  get: () => api.get<AgentMemorySettingsView>("/myrmidon/agent-memory"),
  update: (patch: PatchAgentMemorySettings) => api.patch<AgentMemorySettingsView>("/myrmidon/agent-memory", patch),
};
