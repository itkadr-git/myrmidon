import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPACITY_POLICY,
  capacityPolicyPatchSchema,
  capacityPolicySchema,
  mergeCapacityPolicyPatch,
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
});
