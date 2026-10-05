// myrmidon(BOT-DISK-F): the API client behind the "Disk isolation" panel
// (server/src/myrmidon/bot-containers/scope-routes.ts). Company-scoped.
import { api } from "../../api/client";
import type {
  BotScopeAgentView,
  BotScopeGroupView,
  BotScopeOverview,
  IsolationMode,
  PutScopeAgentPrefBody,
  SettableScopeKind,
} from "@paperclipai/shared";

export type { BotScopeAgentView, BotScopeGroupView, BotScopeOverview, IsolationMode, SettableScopeKind };

export const botScopeQueryKey = (companyId: string) => ["myrmidon", "bot-scopes", companyId] as const;

const base = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/bot-scopes`;

export const botScopeApi = {
  overview: (companyId: string) => api.get<BotScopeOverview>(base(companyId)),
  createGroup: (companyId: string, body: { name: string; memberIds?: string[] }) =>
    api.post<BotScopeGroupView>(`${base(companyId)}/groups`, body),
  patchGroup: (companyId: string, groupId: string, body: { name?: string; memberIds?: string[] }) =>
    api.patch<BotScopeGroupView>(`${base(companyId)}/groups/${encodeURIComponent(groupId)}`, body),
  deleteGroup: (companyId: string, groupId: string) =>
    api.delete<void>(`${base(companyId)}/groups/${encodeURIComponent(groupId)}`),
  putSetting: (companyId: string, kind: SettableScopeKind, scopeId: string, mode: IsolationMode) =>
    api.put<BotScopeOverview>(`${base(companyId)}/settings/${kind}/${encodeURIComponent(scopeId)}`, { mode }),
  deleteSetting: (companyId: string, kind: SettableScopeKind, scopeId: string) =>
    api.delete<BotScopeOverview>(`${base(companyId)}/settings/${kind}/${encodeURIComponent(scopeId)}`),
  putAgent: (companyId: string, agentId: string, body: PutScopeAgentPrefBody) =>
    api.put<BotScopeAgentView>(`${base(companyId)}/agents/${encodeURIComponent(agentId)}`, body),
  apply: (companyId: string, agentId: string) =>
    api.post<BotScopeAgentView>(`${base(companyId)}/agents/${encodeURIComponent(agentId)}/apply`, {}),
  applyAll: (companyId: string) =>
    api.post<{ applied: string[]; skipped: Array<{ agentId: string; reason: string }> }>(`${base(companyId)}/apply-all`, {}),
};

const SOURCE_LABEL: Record<string, string> = {
  agent: "this agent's own choice",
  group: "its group",
  caste: "its caste",
  subtree: "its reporting subtree",
  project: "its project",
  catalog: "its catalog team",
  company: "the whole company",
  default: "the default (nothing configured)",
  unresolved: "an open choice",
};

/** Where an agent's effective scope comes from, in words. */
export function describeScopeSource(agent: BotScopeAgentView): string {
  return SOURCE_LABEL[agent.effective.source] ?? agent.effective.source;
}

/** "Shared root" / "Isolated" for the effective mode of an agent. */
export function describeScopeMode(agent: BotScopeAgentView): string {
  return agent.effective.mode === "shared" ? "Shared root" : "Isolated";
}
