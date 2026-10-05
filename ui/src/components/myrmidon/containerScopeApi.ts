// myrmidon(CONTAINER-SCOPE): the API client behind the "Containers of an
// isolation area" panel (server/src/myrmidon/container-scope/routes.ts).
// Company-scoped, next to the "Disk isolation" panel of BOT-DISK-F.
import { api } from "../../api/client";
import type { ContainerLimits, ContainerMode, ScopeProblem, SettableScopeKind } from "@paperclipai/shared";

export type { ContainerLimits, ContainerMode, SettableScopeKind };

export interface ContainerInstanceView {
  kind: SettableScopeKind;
  ref: string;
  mode: ContainerMode;
  diskMode: "isolated" | "shared" | null;
  label: string;
  agentCount: number;
}

export interface ContainerView {
  containerKey: string;
  shared: boolean;
  scope: { kind: SettableScopeKind; ref: string; label: string } | null;
  members: Array<{ agentId: string; name: string }>;
  limits: ContainerLimits;
  restartRequired: string[];
}

export interface ContainerAgentView {
  agentId: string;
  name: string;
  role: string | null;
  containerKey: string;
  shared: boolean;
  scope: { kind: SettableScopeKind; ref: string; label: string } | null;
  source: string;
  reason: string;
  problems: ScopeProblem[];
  appliedContainerKey: string | null;
  restartRequired: boolean;
  restartReason: string | null;
  enrolled: boolean;
}

export interface ContainerScopeOverview {
  instances: ContainerInstanceView[];
  containers: ContainerView[];
  agents: ContainerAgentView[];
  enrolments: Array<{ containerKey: string; shared: boolean; roster: string[] }>;
  limits: ContainerLimits;
  sharedAgentCount: number;
}

export interface SetContainerInstanceResult {
  instance: ContainerInstanceView;
  restartRequired: string[];
}

export interface ContainerActionPlan {
  agentId: string;
  shared: boolean;
  actions: Array<{ agentId: string; action: "stop" | "start" | "restart" | "keep"; note: string }>;
}

export const containerScopeQueryKey = (companyId: string) => ["myrmidon", "container-scope", companyId] as const;

const base = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/container-scope`;

export const containerScopeApi = {
  overview: (companyId: string) => api.get<ContainerScopeOverview>(base(companyId)),
  putInstance: (companyId: string, body: { kind: SettableScopeKind; ref: string; mode: ContainerMode }) =>
    api.put<SetContainerInstanceResult>(`${base(companyId)}/instances`, body),
  deleteInstance: (companyId: string, kind: SettableScopeKind, ref: string) =>
    api.delete<void>(`${base(companyId)}/instances/${kind}/${encodeURIComponent(ref)}`),
  recompute: (companyId: string) =>
    api.post<{ agents: number; restartRequired: string[] }>(`${base(companyId)}/recompute`, {}),
  markApplied: (companyId: string, agentId: string, containerKey: string) =>
    api.post<{ agent: ContainerAgentView }>(`${base(companyId)}/agents/${encodeURIComponent(agentId)}/applied`, {
      containerKey,
    }),
  planAction: (companyId: string, agentId: string, kind: "pause" | "resume" | "restart" | "rollout") =>
    api.post<ContainerActionPlan>(`${base(companyId)}/agents/${encodeURIComponent(agentId)}/actions`, { kind }),
};

const REASON_LABEL: Record<string, string> = {
  default: "its own area (nothing configured)",
  "agent-isolated": "this agent's own choice",
  "instance-per-agent": "the instance keeps one container per agent",
  "instance-per-scope": "the instance shares one container",
  "instance-invalid": "the instance cannot name a container",
};

/** Why an agent's container is the one it is, in words. */
export function describeContainerReason(agent: ContainerAgentView): string {
  return REASON_LABEL[agent.reason] ?? agent.reason;
}

/** "One container for the area" / "A container per agent". */
export function describeContainerMode(mode: ContainerMode): string {
  return mode === "per-scope" ? "One container for the area" : "A container per agent";
}

/** The limits of one container, in words. */
export function describeLimits(limits: ContainerLimits): string {
  return `${limits.memoryMb} MB, ${limits.cpus} CPU`;
}