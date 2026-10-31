import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPACITY_POLICY,
  applyProjectFairness,
  applyStarvationProtection,
  capacityPolicyPatchSchema,
  capacityPolicySchema,
  checkCapacity,
  mergeCapacityPolicyPatch,
  scoreCandidate,
} from "./myrmidon-capacity-policy.js";

describe("capacity policy contract", () => {
  it("caps a dominant project's share, skips missing IDs, and is deterministic", () => {
    // 20 candidates with 90% (18/20) dominant tasks and 10% (2/20) unassigned tasks
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      issueId: `issue-${String(index).padStart(2, "0")}`,
      priority: "normal",
      queuedAt: index,
      projectId: index < 18 ? "dominant" : null,
    }));
    const policy = { ...DEFAULT_CAPACITY_POLICY, fairness: { perProjectMaxShare: 0.5 } };
    const first = applyProjectFairness(candidates, policy);

    // In the first 4 tasks, dominant share is exactly 2/4 (50% <= perProjectMaxShare)
    expect(first.slice(0, 4).filter((item) => item.projectId === "dominant")).toHaveLength(2);
    // In the first 2 tasks, dominant share is 1/2 (50% <= perProjectMaxShare)
    expect(first.slice(0, 2).filter((item) => item.projectId === "dominant")).toHaveLength(1);
    // Unassigned project tasks create no holes: all candidates are preserved
    expect(first).toHaveLength(20);
    expect(first.every((item) => candidates.some((c) => c.issueId === item.issueId))).toBe(true);
    // Deterministic: multiple calls produce identical order
    expect(first.map((item) => item.issueId)).toEqual(
      applyProjectFairness(candidates, policy).map((item) => item.issueId),
    );
  });

  it("handles empty and missing project identifiers without dropping items", () => {
    const candidates = [
      { issueId: "task-1", priority: "normal", queuedAt: 1, projectId: "" },
      { issueId: "task-2", priority: "normal", queuedAt: 2, projectId: "   " },
      { issueId: "task-3", priority: "normal", queuedAt: 3, projectId: null },
      { issueId: "task-4", priority: "normal", queuedAt: 4, projectId: undefined },
    ];
    const policy = { ...DEFAULT_CAPACITY_POLICY, fairness: { perProjectMaxShare: 0.5 } };
    const result = applyProjectFairness(candidates, policy);
    expect(result.map((item) => item.issueId)).toEqual(["task-1", "task-2", "task-3", "task-4"]);
  });

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

  it("allows candidates below configured project and caste limits", () => {
    const policy = mergeCapacityPolicyPatch(DEFAULT_CAPACITY_POLICY, {
      limits: { perProjectActive: 2, perCasteActive: 3 },
    });
    expect(checkCapacity({
      activeByProject: { projectA: 1 }, activeByCaste: { engineering: 2 },
    }, { projectId: "projectA", casteId: "engineering" }, policy)).toEqual({
      allowed: true, reason: "allowed",
    });
  });

  it("reports which limit prevents admission", () => {
    const policy = mergeCapacityPolicyPatch(DEFAULT_CAPACITY_POLICY, {
      limits: { perProjectActive: 2, perCasteActive: 3 },
    });
    expect(checkCapacity({
      activeByProject: { projectA: 2 }, activeByCaste: { engineering: 0 },
    }, { projectId: "projectA", casteId: "engineering" }, policy)).toEqual({
      allowed: false, reason: "project_limit",
    });
    expect(checkCapacity({
      activeByProject: { projectA: 0 }, activeByCaste: { engineering: 3 },
    }, { projectId: "projectA", casteId: "engineering" }, policy)).toEqual({
      allowed: false, reason: "caste_limit",
    });
  });

  it("treats null limits and unassigned candidates as unbounded", () => {
    expect(checkCapacity({ activeByProject: {}, activeByCaste: {} }, {
      projectId: null, casteId: null,
    }, DEFAULT_CAPACITY_POLICY)).toEqual({ allowed: true, reason: "allowed" });
  });

  it("promotes candidates after the starvation threshold without mutating input", () => {
    const now = Date.parse("2026-01-01T02:00:00Z");
    const old = { priority: "low", createdAt: now - 61 * 60_000 };
    const fresh = { priority: "high", createdAt: now - 60_000 };
    const candidates = [old, fresh];
    const policy = {
      ...DEFAULT_CAPACITY_POLICY,
      starvation: { afterMin: 60, promoteBy: 2 },
    };
    expect(applyStarvationProtection(candidates, now, policy)[0]).toBe(old);
    expect(candidates).toEqual([old, fresh]);
  });

  it("does not starve any candidate through 1000 queue ticks", () => {
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      id: index,
      priority: index === 0 ? "critical" : "low",
      createdAt: index,
    }));
    const policy = {
      ...DEFAULT_CAPACITY_POLICY,
      starvation: { afterMin: 1, promoteBy: 4 },
    };
    const served = new Set<number>();
    for (let tick = 0; tick < 1000; tick += 1) {
      const now = tick * 60_000;
      const next = applyStarvationProtection(candidates, now, policy)[0];
      served.add(next.id);
      candidates.splice(candidates.indexOf(next), 1);
      candidates.push({ ...next, createdAt: now });
    }
    expect([...served].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("treats undefined createdAt as age 0 without starvation promotion", () => {
    const now = Date.parse("2026-01-01T02:00:00Z");
    const freshWithoutDate = { priority: "low" };
    const freshWithDate = { priority: "low", createdAt: now - 10 * 60_000 };
    const candidates = [freshWithoutDate, freshWithDate];
    const policy = {
      ...DEFAULT_CAPACITY_POLICY,
      starvation: { afterMin: 60, promoteBy: 2 },
    };
    const ordered = applyStarvationProtection(candidates, now, policy);
    expect(ordered).toEqual([freshWithDate, freshWithoutDate]);
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

  it("promotes starving tasks across priority bands without indefinite skips", () => {
    const now = Date.parse("2026-01-01T02:00:00Z");
    const candidates = [
      { priority: "low", createdAt: now - 90 * 60_000 },
      { priority: "medium", createdAt: now - 10 * 60_000 },
    ];
    const policy = { ...DEFAULT_CAPACITY_POLICY, starvation: { afterMin: 60, promoteBy: 1 } };
    const ordered = applyStarvationProtection(candidates, now, policy);
    expect(ordered[0].priority).toBe("low");
  });
});
