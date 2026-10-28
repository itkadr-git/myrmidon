import { describe, expect, it } from "vitest";
import { DEFAULT_CAPACITY_POLICY } from "./myrmidon-capacity-policy.js";
import { orderCandidatesWithPolicy } from "./myrmidon-capacity-policy-order.js";
import { orderSwarmQueueCandidates, type SwarmQueueCandidate } from "./myrmidon-swarm-claim.js";

type Candidate = SwarmQueueCandidate & { createdAt: Date | string | number; projectId?: string | null; casteId?: string | null };
const base = Date.parse("2026-01-01T00:00:00Z");

function candidate(issueId: string, priority: string, createdAt: number, projectId: string, casteId = "workers"): Candidate {
  return { issueId, priority, queuedAt: createdAt, createdAt, projectId, casteId } as Candidate;
}

describe("capacity policy composer", () => {
  it("preserves the exact legacy queue order when disabled", () => {
    const candidates: Candidate[] = [
      { issueId: "a", priority: "low", queuedAt: base, createdAt: base },
      { issueId: "b", priority: "critical", queuedAt: base + 1, createdAt: base + 1 },
      { issueId: "c", priority: "normal", queuedAt: base + 2, createdAt: base + 2 },
    ];
    const ctx = { now: base + 10, activeByProject: {}, activeByCaste: {} };
    const result = orderCandidatesWithPolicy(candidates, ctx, { ...DEFAULT_CAPACITY_POLICY, enabled: false });
    expect(result.ordered).toEqual(orderSwarmQueueCandidates(candidates, { now: new Date(ctx.now) }));
    expect(result.rejected).toEqual([]);
  });

  it("composes the integrated fairness, scoring, capacity, and starvation providers by default", () => {
    const candidates = [
      candidate("old", "normal", base - 120 * 60_000, "p1"),
      candidate("fresh", "normal", base - 5 * 60_000, "p2"),
      candidate("p1-next", "normal", base - 30 * 60_000, "p1"),
    ];
    const policy = {
      ...DEFAULT_CAPACITY_POLICY,
      enabled: true,
      fairness: { perProjectMaxShare: 0.5 },
      starvation: { afterMin: 60, promoteBy: 1 },
    };
    const { ordered, rejected } = orderCandidatesWithPolicy(candidates, {
      now: base, activeByProject: {}, activeByCaste: {},
    }, policy);
    expect(ordered.map(({ issueId }) => issueId)).toEqual(["old", "fresh", "p1-next"]);
    expect(rejected).toEqual([]);
  });

  it("enforces priority ordering invariant (critical > high > normal > low)", () => {
    const candidates: Candidate[] = [
      candidate("low-old", "low", base - 200 * 60_000, "p1"),
      candidate("norm-fresh", "normal", base - 10 * 60_000, "p2"),
      candidate("crit-fresh", "critical", base - 5 * 60_000, "p3"),
      candidate("high-fresh", "high", base - 8 * 60_000, "p4"),
    ];
    const policy = {
      ...DEFAULT_CAPACITY_POLICY,
      enabled: true,
      starvation: { afterMin: 1000, promoteBy: 1 },
    };
    const { ordered, rejected } = orderCandidatesWithPolicy(candidates, {
      now: base, activeByProject: {}, activeByCaste: {},
    }, policy);
    expect(ordered.map(({ issueId }) => issueId)).toEqual(["crit-fresh", "high-fresh", "norm-fresh", "low-old"]);
    expect(rejected).toEqual([]);
  });

  it("enforces project fairness interleaving invariant", () => {
    const candidates: Candidate[] = [
      candidate("p1-1", "normal", base - 50 * 60_000, "p1"),
      candidate("p1-2", "normal", base - 40 * 60_000, "p1"),
      candidate("p1-3", "normal", base - 30 * 60_000, "p1"),
      candidate("p2-1", "normal", base - 20 * 60_000, "p2"),
    ];
    const policy = {
      ...DEFAULT_CAPACITY_POLICY,
      enabled: true,
      fairness: { perProjectMaxShare: 0.5 },
    };
    const { ordered } = orderCandidatesWithPolicy(candidates, {
      now: base, activeByProject: {}, activeByCaste: {},
    }, policy);
    expect(ordered.map(({ issueId }) => issueId)).toEqual(["p1-1", "p2-1", "p1-2", "p1-3"]);
  });

  it("enforces starvation promotion invariant", () => {
    const candidates: Candidate[] = [
      candidate("normal-fresh", "normal", base - 10 * 60_000, "p1"),
      candidate("low-starved", "low", base - 180 * 60_000, "p2"),
    ];
    const policy = {
      ...DEFAULT_CAPACITY_POLICY,
      enabled: true,
      starvation: { afterMin: 60, promoteBy: 2 },
    };
    const { ordered } = orderCandidatesWithPolicy(candidates, {
      now: base, activeByProject: {}, activeByCaste: {},
    }, policy);
    expect(ordered.map(({ issueId }) => issueId)).toEqual(["low-starved", "normal-fresh"]);
  });

  it("returns provider capacity rejection reasons for project and caste limits", () => {
    const candidates: Candidate[] = [
      candidate("p-capped", "critical", base, "p1"),
      candidate("c-capped", "normal", base + 1, "p2", "design"),
      candidate("allowed", "low", base + 2, "p3", "workers"),
    ];
    const policy = {
      ...DEFAULT_CAPACITY_POLICY,
      enabled: true,
      limits: { perProjectActive: 1, perCasteActive: 1 },
    };
    const { ordered, rejected } = orderCandidatesWithPolicy(candidates, {
      now: base + 10, activeByProject: { p1: 1 }, activeByCaste: { design: 1 },
    }, policy);
    expect(ordered.map(({ issueId }) => issueId)).toEqual(["allowed"]);
    expect(rejected).toEqual([
      { id: "p-capped", candidate: candidates[0], reason: "project_limit" },
      { id: "c-capped", candidate: candidates[1], reason: "caste_limit" },
    ]);
  });
});
