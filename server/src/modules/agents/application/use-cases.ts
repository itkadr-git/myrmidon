// server/src/modules/agents/application/use-cases.ts
//
import type { CompanyTierReader } from "./ports.js";
import { evaluateAgentQuota, type QuotaEvaluationResult } from "../domain/quota.js";

export class AgentQuotaExceededError extends Error {
  readonly code = "quota_exceeded" as const;
  readonly status = 403;
  readonly currentCount: number;
  readonly quota: number;
  readonly tier: string;

  constructor(decision: QuotaEvaluationResult) {
    super(
      `Agent quota exceeded for company tier '${decision.tier}': current active agents (${decision.currentCount}) reached or exceeded quota (${decision.quota})`,
    );
    this.name = "AgentQuotaExceededError";
    this.currentCount = decision.currentCount;
    this.quota = decision.quota;
    this.tier = decision.tier;
  }
}

export interface AssertCompanyAgentQuotaDeps {
  reader: CompanyTierReader;
}

export function createAssertCompanyAgentQuota(deps: AssertCompanyAgentQuotaDeps) {
  return async function assertCompanyAgentQuota(companyId: string): Promise<QuotaEvaluationResult> {
    // myrmidon(1.7 TIER-QUOTA-CHECK OPE-12092): the company_tiers table ships
    // with 1.7 TIER-SCHEMA (OPE-12091). Until that migration is deployed,
    // quota enforcement stays dormant — no company may get a surprise 403
    // from a schema it does not have yet. Once deployed, a company without a
    // tier row defaults to 'free' with quota 5, and the quota is enforced.
    const schemaDeployed = deps.reader.isSchemaDeployed
      ? await deps.reader.isSchemaDeployed()
      : true;
    if (!schemaDeployed) {
      return {
        allowed: true,
        currentCount: 0,
        quota: Number.POSITIVE_INFINITY,
        tier: "not_deployed",
      };
    }

    const [tierInfo, currentActiveAgentCount] = await Promise.all([
      deps.reader.getCompanyTier(companyId),
      deps.reader.countActiveAgents(companyId),
    ]);

    const decision = evaluateAgentQuota({
      currentActiveAgentCount,
      agentQuota: tierInfo?.agentQuota,
      tier: tierInfo?.tier,
    });

    if (!decision.allowed) {
      throw new AgentQuotaExceededError(decision);
    }

    return decision;
  };
}
