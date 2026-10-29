// myrmidon(M2-B): per-agent LLM gateway keys and the gateway's fallback
// topology. GET/POST /api/myrmidon/companies/:id/litellm/keys/*
// myrmidon(OPE-9859): Key budget projection per agent and service.
import { api } from "@/api/client";

export interface KeyBudgetLimitView {
  amountUsd: number | null;
  periodHours: number;
  mode: "block" | "soft";
  effectiveMode: "block" | "soft";
  caste: string | null;
}

export interface AgentGatewayKeyView {
  agentId: string;
  agentName?: string | null;
  role?: string | null;
  secretName: string;
  present: boolean;
  /** sha256 of the key value — the only form the value is ever reported in. */
  valueHash: string | null;
  canManageKeys: boolean;
  budget?: KeyBudgetLimitView | null;
}

export interface ServiceKeyBudgetView {
  serviceId: string;
  serviceName: string;
  level: "caste" | "nest" | "foraging" | "ticket";
  scopeId: string;
  tag: string;
  secretName: string | null;
  budget: KeyBudgetLimitView;
}

export interface CompanyKeyBudgetsReport {
  companyId: string;
  signalOnly: boolean;
  projectionEnabled: boolean;
  agents: AgentGatewayKeyView[];
  services: ServiceKeyBudgetView[];
}

export interface GatewayFallbackCycle {
  path: string[];
  described: string;
}

export interface GatewayFallbackReport {
  chains: Array<{ model: string; targets: string[] }>;
  cycles: GatewayFallbackCycle[];
  error?: string;
}

/** 503 body while the instance switch is off: the tab says "not enabled". */
export function isKeysNotEnabledError(err: unknown): boolean {
  return err instanceof Error && /not enabled/i.test(err.message);
}

const base = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/litellm`;

export const litellmKeysApi = {
  keys: (companyId: string) => api.get<AgentGatewayKeyView[]>(`${base(companyId)}/keys`),
  keyBudgets: (companyId: string) => api.get<CompanyKeyBudgetsReport>(`${base(companyId)}/key-budgets`),
  fallbacks: (companyId: string) => api.get<GatewayFallbackReport>(`${base(companyId)}/fallbacks`),
  create: (companyId: string, agentId: string) =>
    api.post<AgentGatewayKeyView & { value: string }>(
      `${base(companyId)}/keys/${encodeURIComponent(agentId)}`,
      {},
    ),
  rotate: (companyId: string, agentId: string) =>
    api.post<AgentGatewayKeyView>(`${base(companyId)}/keys/${encodeURIComponent(agentId)}/rotate`, {}),
};

export const litellmKeysKey = (companyId: string) =>
  ["myrmidon", "litellm", "keys", companyId] as const;
export const litellmKeyBudgetsKey = (companyId: string) =>
  ["myrmidon", "litellm", "key-budgets", companyId] as const;
export const litellmFallbacksKey = (companyId: string) =>
  ["myrmidon", "litellm", "fallbacks", companyId] as const;

/** How many agents of a company already have a key of their own. */
export function countKeyedAgents(keys: AgentGatewayKeyView[]): { keyed: number; total: number } {
  return { keyed: keys.filter((entry) => entry.present).length, total: keys.length };
}
