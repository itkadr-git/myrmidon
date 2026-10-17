// Agent nests (myrmidon 1.6.5 F-26 T3 CASTES-AND-NESTS): the projects an agent
// is willing to work in.
//
//   GET /api/myrmidon/companies/:companyId/agents/:agentId/nests
//   PUT /api/myrmidon/companies/:companyId/agents/:agentId/nests  { projectIds }
//
// An empty list is "the whole company": the agent may take every task. The
// server reads the pairs fresh on every matcher pass, so saving the
// multi-select in the agent card changes the match without a restart.
import type { AgentNestsView } from "@paperclipai/shared";
import { api } from "@/api/client";

export type { AgentNestsView };

const base = (companyId: string, agentId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/agents/${encodeURIComponent(agentId)}/nests`;

export const agentNestsQueryKey = (companyId: string, agentId: string) =>
  ["myrmidon", "agent-nests", companyId, agentId] as const;

export const agentNestsApi = {
  get: (companyId: string, agentId: string) => api.get<AgentNestsView>(base(companyId, agentId)),
  put: (companyId: string, agentId: string, projectIds: string[]) =>
    api.put<AgentNestsView>(base(companyId, agentId), { projectIds }),
};