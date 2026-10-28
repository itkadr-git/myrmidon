import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPACITY_POLICY,
  capacityPolicyPatchSchema,
  capacityPolicySchema,
  mergeCapacityPolicyPatch,
  scoreCandidate,
} from "./myrmidon-capacity-policy.js";

describe("capacity policy contract", () => {
  it("defaults to disabled and supplies section defaults", () => {
    const parsed = capacityPolicySchema.parse({});
    expect(parsed).toEqual(DEFAULT_CAPACITY_POLICY);
    expect(parsed.enabled).toBe(false);
  });

  it("rejects out-of-range shares and invalid numeric limits", () => {
    expect(capacityPolicySchema.safeParse({
      ...DEFAULT_CAPACITY_POLICY, fairness: { perProjectMaxShare: 1.01 },
    }).success).toBe(false);
    expect(capacityPolicySchema.safeParse({
      ...DEFAULT_CAPACITY_POLICY, limits: { perProjectActive: -1, perCasteActive: null },
    }).success).toBe(false);
    expect(capacityPolicySchema.safeParse({
      ...DEFAULT_CAPACITY_POLICY, aging: { halfLifeMin: Number.POSITIVE_INFINITY, maxBoost: 0 },
    }).success).toBe(false);
    expect(capacityPolicyPatchSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("deep-merges a partial patch with defaults", () => {
    expect(mergeCapacityPolicyPatch(DEFAULT_CAPACITY_POLICY, {
      aging: { maxBoost: 2 }, limits: { perProjectActive: 4 },
    })).toEqual({
      ...DEFAULT_CAPACITY_POLICY,
      aging: { ...DEFAULT_CAPACITY_POLICY.aging, maxBoost: 2 },
      limits: { ...DEFAULT_CAPACITY_POLICY.limits, perProjectActive: 4 },
    });
  });

  it("scores priority bands above aging while keeping aging monotone and capped", () => {
    const now = Date.parse("2026-01-01T01:00:00Z");
    const candidate = (priority: string, ageMin: number) => ({ priority, createdAt: now - ageMin * 60_000 });
    const policy = { ...DEFAULT_CAPACITY_POLICY, aging: { halfLifeMin: 60, maxBoost: 1 } };

    // P0 (critical) always higher than low priority at equal age
    expect(scoreCandidate(candidate("critical", 0), now, policy)).toBeGreaterThan(
      scoreCandidate(candidate("low", 0), now, policy),
    );
    expect(scoreCandidate(candidate("critical", 60), now, policy)).toBeGreaterThan(
      scoreCandidate(candidate("low", 60), now, policy),
    );

    // Aging increases score monotonically, capped at maxBoost
    const t0 = scoreCandidate(candidate("low", 0), now, policy);
    const t30 = scoreCandidate(candidate("low", 30), now, policy);
    const t60 = scoreCandidate(candidate("low", 60), now, policy);
    const t120 = scoreCandidate(candidate("low", 120), now, policy);
    const tAncient = scoreCandidate(candidate("low", 100_000), now, policy);

    expect(t30).toBeGreaterThan(t0);
    expect(t60).toBeGreaterThan(t30);
    expect(t120).toBeGreaterThan(t60);
    expect(tAncient).toBeGreaterThanOrEqual(t120);
    expect(tAncient).toBeLessThanOrEqual(t0 + policy.aging.maxBoost);
  });
});
