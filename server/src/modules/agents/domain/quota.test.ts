import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_QUOTA,
  DEFAULT_COMPANY_TIER,
  evaluateAgentQuota,
} from "./quota.js";

describe("evaluateAgentQuota", () => {
  it("allows creation when within quota (active count < quota)", () => {
    const result = evaluateAgentQuota({
      currentActiveAgentCount: 2,
      agentQuota: 5,
      tier: "pro",
    });

    expect(result).toEqual({
      allowed: true,
      currentCount: 2,
      quota: 5,
      tier: "pro",
    });
  });

  it("denies creation when at quota (active count === quota)", () => {
    const result = evaluateAgentQuota({
      currentActiveAgentCount: 5,
      agentQuota: 5,
      tier: "pro",
    });

    expect(result).toEqual({
      allowed: false,
      currentCount: 5,
      quota: 5,
      tier: "pro",
    });
  });

  it("denies creation when over quota (active count > quota)", () => {
    const result = evaluateAgentQuota({
      currentActiveAgentCount: 6,
      agentQuota: 5,
      tier: "pro",
    });

    expect(result).toEqual({
      allowed: false,
      currentCount: 6,
      quota: 5,
      tier: "pro",
    });
  });

  it("defaults tier to 'free' and quota to 5 when tier is absent (undefined)", () => {
    const result = evaluateAgentQuota({
      currentActiveAgentCount: 3,
    });

    expect(result).toEqual({
      allowed: true,
      currentCount: 3,
      quota: DEFAULT_AGENT_QUOTA,
      tier: DEFAULT_COMPANY_TIER,
    });
  });

  it("defaults tier to 'free' and quota to 5 when tier is absent (null)", () => {
    const result = evaluateAgentQuota({
      currentActiveAgentCount: 5,
      agentQuota: null,
      tier: null,
    });

    expect(result).toEqual({
      allowed: false,
      currentCount: 5,
      quota: DEFAULT_AGENT_QUOTA,
      tier: DEFAULT_COMPANY_TIER,
    });
  });

  it("handles zero quota correctly", () => {
    const result = evaluateAgentQuota({
      currentActiveAgentCount: 0,
      agentQuota: 0,
      tier: "suspended",
    });

    expect(result).toEqual({
      allowed: false,
      currentCount: 0,
      quota: 0,
      tier: "suspended",
    });
  });
});
