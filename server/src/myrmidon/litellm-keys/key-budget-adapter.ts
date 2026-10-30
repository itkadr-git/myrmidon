// server/src/myrmidon/litellm-keys/key-budget-adapter.ts
//
// myrmidon(OPE-9859): Adapter projecting budgets/limits onto LiteLLM keys
// for agents and services using OPE-8675 budget projection as the single
// source of truth. Parallel storage is strictly prohibited.

import { eq } from "drizzle-orm";
import { agents, type Db } from "@myrmidon/db";
import {
  budgetProjectionTag,
  type BudgetProjectionLimit,
  type BudgetProjectionStoredSettings,
} from "@myrmidon/shared";
import { readBudgetProjectionSettings } from "../litellm-budget-sync/settings.js";
import {
  agentKeySecretName,
  gatewayKeyValueHash,
  readGatewayKeySettings,
  type AgentGatewayKeyDeps,
} from "./agent-keys.js";

/** Key budget ceiling details formatted for UI display and enforcement checks. */
export interface KeyBudgetLimitView {
  amountUsd: number | null;
  periodHours: number;
  mode: "block" | "soft";
  effectiveMode: "block" | "soft";
  caste: string | null;
}

/** Projected key view for an agent. */
export interface AgentKeyBudgetView {
  agentId: string;
  agentName: string | null;
  role: string | null;
  secretName: string;
  present: boolean;
  valueHash: string | null;
  canManageKeys: boolean;
  budget: KeyBudgetLimitView | null;
}

/** Projected key view for a service or hierarchy scope. */
export interface ServiceKeyBudgetView {
  serviceId: string;
  serviceName: string;
  level: "caste" | "nest" | "foraging" | "ticket";
  scopeId: string;
  tag: string;
  secretName: string | null;
  budget: KeyBudgetLimitView;
}

/** Aggregate report of keys and their projected budgets for a company. */
export interface CompanyKeyBudgetsReport {
  companyId: string;
  signalOnly: boolean;
  projectionEnabled: boolean;
  agents: AgentKeyBudgetView[];
  services: ServiceKeyBudgetView[];
}

/**
 * Pure adapter projecting the stored budget projection document onto agent
 * and service keys without storing any duplicate state.
 */
export function adaptKeyBudgetProjection(input: {
  companyId: string;
  settings: BudgetProjectionStoredSettings;
  agents: Array<{ id: string; name: string; role: string | null }>;
  keys?: Array<{
    agentId: string;
    secretName: string;
    present: boolean;
    valueHash: string | null;
    canManageKeys: boolean;
  }>;
}): CompanyKeyBudgetsReport {
  const { companyId, settings, agents: agentList, keys = [] } = input;
  const keyMap = new Map(keys.map((k) => [k.agentId, k]));

  // Index caste limits: key is `caste:<scopeId>`
  const casteLimits = new Map<string, BudgetProjectionLimit>();
  for (const limit of settings.limits) {
    if (limit.level === "caste") {
      casteLimits.set(limit.scopeId, limit);
    }
  }

  // Known agent roles in this company
  const agentRoles = new Set<string>();

  // Map agents with their caste ceiling
  const agentViews: AgentKeyBudgetView[] = agentList.map((agent) => {
    if (agent.role) {
      agentRoles.add(agent.role);
    }

    const keyInfo = keyMap.get(agent.id);
    const secretName = keyInfo?.secretName ?? agentKeySecretName({ agentId: agent.id, agentSlug: agent.name });
    const present = keyInfo?.present ?? false;
    const valueHash = keyInfo?.valueHash ?? null;
    const canManageKeys = keyInfo?.canManageKeys ?? true;

    let budget: KeyBudgetLimitView | null = null;
    if (agent.role && casteLimits.has(agent.role)) {
      const match = casteLimits.get(agent.role)!;
      if (match.amountUsd > 0) {
        budget = {
          amountUsd: match.amountUsd,
          periodHours: match.periodHours,
          mode: match.mode,
          effectiveMode: settings.signalOnly || match.mode === "soft" ? "soft" : "block",
          caste: agent.role,
        };
      }
    }

    return {
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      secretName,
      present,
      valueHash,
      canManageKeys,
      budget,
    };
  });

  // Map services: limits at caste (non-agent or service), nest, foraging
  const serviceViews: ServiceKeyBudgetView[] = [];
  for (const limit of settings.limits) {
    if (limit.amountUsd <= 0) continue;

    const isAgentCaste = limit.level === "caste" && agentRoles.has(limit.scopeId);
    if (isAgentCaste) {
      // Already covered by agent projections
      continue;
    }

    const tag = budgetProjectionTag(limit.level, limit.scopeId);
    const secretName = limit.level === "caste" ? `llm-gateway-key-${limit.scopeId}` : null;

    serviceViews.push({
      serviceId: `${limit.level}:${limit.scopeId}`,
      serviceName: limit.scopeId,
      level: limit.level,
      scopeId: limit.scopeId,
      tag,
      secretName,
      budget: {
        amountUsd: limit.amountUsd,
        periodHours: limit.periodHours,
        mode: limit.mode,
        effectiveMode: settings.signalOnly || limit.mode === "soft" ? "soft" : "block",
        caste: limit.level === "caste" ? limit.scopeId : null,
      },
    });
  }

  return {
    companyId,
    signalOnly: settings.signalOnly,
    projectionEnabled: settings.enabled,
    agents: agentViews,
    services: serviceViews,
  };
}

/**
 * Reads agent keys and OPE-8675 budget projection from DB and adapts them.
 */
export async function readCompanyKeyBudgets(
  deps: AgentGatewayKeyDeps,
  companyId: string,
): Promise<CompanyKeyBudgetsReport> {
  const settings = readGatewayKeySettings(deps.env ?? process.env);
  const projection = await readBudgetProjectionSettings(deps.db, companyId);

  const rows = await deps.db
    .select({ id: agents.id, name: agents.name, role: agents.role })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const keys: Array<{
    agentId: string;
    secretName: string;
    present: boolean;
    valueHash: string | null;
    canManageKeys: boolean;
  }> = [];

  for (const row of rows) {
    const secretName = agentKeySecretName({ agentId: row.id, agentSlug: row.name });
    const value = await deps.readSecretValue(companyId, secretName);
    keys.push({
      agentId: row.id,
      secretName,
      present: Boolean(value),
      valueHash: value ? gatewayKeyValueHash(value) : null,
      canManageKeys: settings.canManageKeys,
    });
  }

  return adaptKeyBudgetProjection({
    companyId,
    settings: projection,
    agents: rows,
    keys,
  });
}
