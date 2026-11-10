// server/src/modules/agents/application/ports.ts

export interface CompanyTierInfo {
  tier: string;
  agentQuota: number;
}

export interface CompanyTierReader {
  /**
   * Returns the company tier and agent quota, or null if no tier is configured.
   */
  getCompanyTier(companyId: string): Promise<CompanyTierInfo | null>;

  /**
   * Returns false only when the company-tier schema has not been deployed yet.
   * Older installations should not be quota-limited before the schema migration.
   */
  isSchemaDeployed?(): Promise<boolean>;

  /**
   * Counts existing active (non-terminated) agents for the company.
   */
  countActiveAgents(companyId: string): Promise<number>;
}
