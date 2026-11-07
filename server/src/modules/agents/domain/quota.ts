// server/src/modules/agents/domain/quota.ts

export const DEFAULT_AGENT_QUOTA = 5;
export const DEFAULT_COMPANY_TIER = "free";

export interface QuotaEvaluationInput {
  currentActiveAgentCount: number;
  agentQuota?: number | null;
  tier?: string | null;
}

export interface QuotaEvaluationResult {
  allowed: boolean;
  currentCount: number;
  quota: number;
  tier: string;
}

/**
 * Pure domain policy: evaluates whether a new agent can be created for the company
 * given its current active agent count and configured tier quota.
 *
 * Acceptance criteria:
 * - When within quota: creation is allowed.
 * - When at or over quota: creation is denied.
 * - When tier or quota is absent (null/undefined): defaults to 'free' tier with quota = 5.
 */
export function evaluateAgentQuota(input: QuotaEvaluationInput): QuotaEvaluationResult {
  const quota =
    typeof input.agentQuota === "number" && Number.isFinite(input.agentQuota) && input.agentQuota >= 0
      ? input.agentQuota
      : DEFAULT_AGENT_QUOTA;

  const tier =
    typeof input.tier === "string" && input.tier.trim() !== ""
      ? input.tier.trim()
      : DEFAULT_COMPANY_TIER;

  return {
    allowed: input.currentActiveAgentCount < quota,
    currentCount: input.currentActiveAgentCount,
    quota,
    tier,
  };
}
