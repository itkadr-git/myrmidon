// Agent memory (myrmidon MEMORY-UI): GET/PATCH /api/myrmidon/agent-memory.
//
// The memory service address, the optional key secret name, access control policies,
// banks, and workload monitoring behind the agent memory settings panel.
// The server re-reads them on every request, so a change applies without a restart.
import type {
  AgentMemoryAccessMode,
  AgentMemorySettings,
  HindsightBankConfig,
  HindsightBankSummary,
  HindsightRecallProbeResult,
  HindsightWorkloadMetrics,
  PatchAgentMemorySettings,
} from "@myrmidon/shared";
import { api } from "@/api/client";

export interface AgentMemorySettingsView {
  settings: AgentMemorySettings;
  effective: {
    enabled: boolean;
    apiUrl: string | null;
    urlSource: "setting" | "env" | "bot-env" | null;
    keySecretName: string | null;
    accessMode: AgentMemoryAccessMode;
    enabledRoles: string[];
    enabledAgentIds: string[];
  };
}

export const agentMemoryQueryKey = ["myrmidon", "agent-memory"] as const;
export const agentMemoryBanksKey = ["myrmidon", "agent-memory", "banks"] as const;
export const agentMemoryWorkloadKey = ["myrmidon", "agent-memory", "workload"] as const;

export const agentMemoryApi = {
  get: () => api.get<AgentMemorySettingsView>("/myrmidon/agent-memory"),
  update: (patch: PatchAgentMemorySettings) => api.patch<AgentMemorySettingsView>("/myrmidon/agent-memory", patch),
  listBanks: () => api.get<HindsightBankSummary[]>("/myrmidon/agent-memory/banks"),
  getBankConfig: (bankId: string) => api.get<HindsightBankConfig>(`/myrmidon/agent-memory/banks/${encodeURIComponent(bankId)}/config`),
  updateBankConfig: (bankId: string, patch: Record<string, unknown>) =>
    api.patch<HindsightBankConfig>(`/myrmidon/agent-memory/banks/${encodeURIComponent(bankId)}/config`, patch),
  getWorkload: (bankId?: string) =>
    api.get<HindsightWorkloadMetrics>(`/myrmidon/agent-memory/workload${bankId ? `?bankId=${encodeURIComponent(bankId)}` : ""}`),
  retryOperation: (bankId: string, operationId: string) =>
    api.post<{ success: boolean; id: string }>(
      `/myrmidon/agent-memory/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}/retry`,
      {},
    ),
  probeRecall: (query: string, bankId?: string) =>
    api.post<HindsightRecallProbeResult>("/myrmidon/agent-memory/probe", { query, bankId }),
};