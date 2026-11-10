import { describe, expect, it, vi } from "vitest";
import type { CompanyTierInfo, CompanyTierReader } from "./ports.js";
import {
  AgentQuotaExceededError,
  createAssertCompanyAgentQuota,
} from "./use-cases.js";

function createFakeReader(params: {
  tierInfo?: CompanyTierInfo | null;
  activeCount?: number;
  schemaDeployed?: boolean;
}): Required<CompanyTierReader> {
  return {
    isSchemaDeployed: vi.fn(async () => params.schemaDeployed ?? true),
    getCompanyTier: vi.fn(async () => params.tierInfo ?? null),
    countActiveAgents: vi.fn(async () => params.activeCount ?? 0),
  };
}

describe("createAssertCompanyAgentQuota", () => {
  it("allows creation when within quota", async () => {
    const reader = createFakeReader({
      tierInfo: { tier: "enterprise", agentQuota: 20 },
      activeCount: 15,
    });
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    const decision = await assertQuota("company-123");

    expect(decision).toEqual({
      allowed: true,
      currentCount: 15,
      quota: 20,
      tier: "enterprise",
    });
    expect(reader.getCompanyTier).toHaveBeenCalledWith("company-123");
    expect(reader.countActiveAgents).toHaveBeenCalledWith("company-123");
  });

  it("throws AgentQuotaExceededError with 403 and quota_exceeded when active count equals quota", async () => {
    const reader = createFakeReader({
      tierInfo: { tier: "pro", agentQuota: 10 },
      activeCount: 10,
    });
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    await expect(assertQuota("company-123")).rejects.toThrow(AgentQuotaExceededError);

    try {
      await assertQuota("company-123");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AgentQuotaExceededError);
      const quotaErr = err as AgentQuotaExceededError;
      expect(quotaErr.code).toBe("quota_exceeded");
      expect(quotaErr.status).toBe(403);
      expect(quotaErr.currentCount).toBe(10);
      expect(quotaErr.quota).toBe(10);
      expect(quotaErr.tier).toBe("pro");
    }
  });

  it("throws AgentQuotaExceededError when active count exceeds quota", async () => {
    const reader = createFakeReader({
      tierInfo: { tier: "free", agentQuota: 5 },
      activeCount: 7,
    });
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    await expect(assertQuota("company-123")).rejects.toThrow(AgentQuotaExceededError);
  });

  it("defaults to tier 'free' and quota 5 when tier is absent from reader", async () => {
    const reader = createFakeReader({
      tierInfo: null,
      activeCount: 4,
    });
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    const decision = await assertQuota("company-123");

    expect(decision).toEqual({
      allowed: true,
      currentCount: 4,
      quota: 5,
      tier: "free",
    });
  });

  it("denies creation when tier is absent and active count reaches default quota 5", async () => {
    const reader = createFakeReader({
      tierInfo: null,
      activeCount: 5,
    });
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    await expect(assertQuota("company-123")).rejects.toThrow(AgentQuotaExceededError);

    try {
      await assertQuota("company-123");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AgentQuotaExceededError);
      const quotaErr = err as AgentQuotaExceededError;
      expect(quotaErr.code).toBe("quota_exceeded");
      expect(quotaErr.status).toBe(403);
      expect(quotaErr.currentCount).toBe(5);
      expect(quotaErr.quota).toBe(5);
      expect(quotaErr.tier).toBe("free");
    }
  });

  it("stays dormant when the company-tier schema is not deployed yet (legacy instance)", async () => {
    const reader = createFakeReader({
      tierInfo: null,
      activeCount: 50,
      schemaDeployed: false,
    });
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    const decision = await assertQuota("company-123");

    expect(decision.allowed).toBe(true);
    expect(reader.getCompanyTier).not.toHaveBeenCalled();
  });

  it("still enforces the default quota when the schema is deployed and the reader omits isSchemaDeployed", async () => {
    // Reader built before isSchemaDeployed existed: absence of the optional
    // probe means the caller assumes the schema is deployed.
    const reader: CompanyTierReader = {
      getCompanyTier: async () => null,
      countActiveAgents: async () => 5,
    };
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    await expect(assertQuota("company-123")).rejects.toThrow(AgentQuotaExceededError);
  });

  // myrmidon(1.7 TIER-QUOTA-CHECK OPE-12092, PR #2712 changes-requested): a
  // database READ FAILURE must never be readable as "0 active agents" or "no
  // tier row" — either would silently allow creation beyond the quota
  // (fail-open). None of the three reader methods may return a permissive
  // value from a catch block; failures propagate and the middleware forwards
  // them to next(err) (500), which is louder and safer than a silent bypass.
  it("propagates countActiveAgents read failures instead of allowing creation with a fake 0 count", async () => {
    const reader = createFakeReader({ tierInfo: { tier: "pro", agentQuota: 10 } });
    vi.mocked(reader.countActiveAgents).mockRejectedValue(new Error("count query failed"));
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    await expect(assertQuota("company-123")).rejects.toThrow("count query failed");
    // No quota decision was made on fabricated data.
    await expect(assertQuota("company-123")).rejects.not.toBeInstanceOf(AgentQuotaExceededError);
  });

  it("propagates getCompanyTier read failures instead of silently applying the free-tier default", async () => {
    const reader = createFakeReader({ tierInfo: { tier: "pro", agentQuota: 10 } });
    vi.mocked(reader.getCompanyTier).mockRejectedValue(new Error("tier lookup failed"));
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    await expect(assertQuota("company-123")).rejects.toThrow("tier lookup failed");
    await expect(assertQuota("company-123")).rejects.not.toBeInstanceOf(AgentQuotaExceededError);
  });

  it("propagates isSchemaDeployed probe failures instead of treating them as 'schema not deployed'", async () => {
    const reader = createFakeReader({ tierInfo: null, activeCount: 50 });
    vi.mocked(reader.isSchemaDeployed).mockRejectedValue(new Error("probe failed"));
    const assertQuota = createAssertCompanyAgentQuota({ reader });

    await expect(assertQuota("company-123")).rejects.toThrow("probe failed");
    // Dormancy (the not_deployed allow-all) must not be reachable through a
    // failing probe: enforcement stays on when enforcement cannot read.
    await expect(assertQuota("company-123")).rejects.not.toBeInstanceOf(AgentQuotaExceededError);
    expect(reader.getCompanyTier).not.toHaveBeenCalled();
  });
});
