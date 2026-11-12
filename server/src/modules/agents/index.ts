// server/src/modules/agents/index.ts

import type { Request, Response, NextFunction } from "express";
import type { Db } from "@myrmidon/db";
import { createPostgresCompanyTierReader } from "./adapters/postgres.js";
import type { CompanyTierInfo, CompanyTierReader } from "./application/ports.js";
import {
  createAssertCompanyAgentQuota,
  AgentQuotaExceededError,
} from "./application/use-cases.js";
import {
  DEFAULT_AGENT_QUOTA,
  DEFAULT_COMPANY_TIER,
  evaluateAgentQuota,
  type QuotaEvaluationInput,
  type QuotaEvaluationResult,
} from "./domain/quota.js";
import { forbidden } from "../../errors.js";

export {
  DEFAULT_AGENT_QUOTA,
  DEFAULT_COMPANY_TIER,
  evaluateAgentQuota,
  AgentQuotaExceededError,
  createAssertCompanyAgentQuota,
  createPostgresCompanyTierReader,
};
export type {
  CompanyTierInfo,
  CompanyTierReader,
  QuotaEvaluationInput,
  QuotaEvaluationResult,
};

export interface AgentsModuleDeps {
  reader?: CompanyTierReader;
}

export function createAgentQuotaMiddleware(assertQuota: (companyId: string) => Promise<unknown>) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const rawCompanyId = req.params.companyId;
    const companyId = Array.isArray(rawCompanyId) ? rawCompanyId[0] : rawCompanyId;
    if (!companyId) {
      next();
      return;
    }
    try {
      await assertQuota(companyId);
      next();
    } catch (err: unknown) {
      if (err instanceof AgentQuotaExceededError) {
        next(forbidden(err.message, { code: "quota_exceeded" }));
        return;
      }
      next(err);
    }
  };
}

/**
 * Composes the agents module: company tier & agent quota domain policies,
 * use cases, and database adapters.
 */
export function createAgentsModule(db: Db, deps: AgentsModuleDeps = {}) {
  const reader = deps.reader ?? createPostgresCompanyTierReader(db);
  const assertCompanyAgentQuota = createAssertCompanyAgentQuota({ reader });

  return {
    reader,
    assertCompanyAgentQuota,
    quotaMiddleware: () => createAgentQuotaMiddleware(assertCompanyAgentQuota),
  };
}

export type AgentsModule = ReturnType<typeof createAgentsModule>;
