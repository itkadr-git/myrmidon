import { orderSwarmQueueCandidates, swarmPriorityRank, type SwarmQueueCandidate } from "./myrmidon-swarm-claim.js";
import {
  type CapacityCandidate,
  type CapacityMetrics,
  type CapacityDecision,
  type CapacityDecisionReason,
  type CapacityPolicy,
  capacityPolicySchema,
  DEFAULT_CAPACITY_POLICY,
  checkCapacity,
  applyProjectFairness,
  applyStarvationProtection,
  scoreCandidate,
} from "./myrmidon-capacity-policy.js";

export interface CapacityPolicyPorts<T extends SwarmQueueCandidate & CapacityCandidate> {
  fairness: (candidates: readonly T[], policy: CapacityPolicy) => T[];
  score: (candidate: T, now: Date | string | number, policy: CapacityPolicy) => number;
  capacity: (metrics: Pick<CapacityMetrics, "activeByProject" | "activeByCaste">, candidate: T, policy: CapacityPolicy) => CapacityDecision;
  starvation: (candidates: readonly T[], now: Date | string | number, policy: CapacityPolicy) => T[];
}

export interface CapacityPolicyContext {
  now: Date | string | number;
  activeByProject: Readonly<Record<string, number>>;
  activeByCaste: Readonly<Record<string, number>>;
  queueOptions?: Parameters<typeof orderSwarmQueueCandidates>[1];
}

export interface RejectedCapacityCandidate<T> {
  id: string;
  candidate: T;
  reason: Exclude<CapacityDecisionReason, "allowed">;
}

export interface CapacityPolicyResult<T> {
  ordered: T[];
  rejected: RejectedCapacityCandidate<T>[];
}

/** Compose the K2-K6 providers while preserving legacy order when disabled. */
export function orderCandidatesWithPolicy<T extends SwarmQueueCandidate & CapacityCandidate & { projectId?: string | null; casteId?: string | null }>(
  candidates: readonly T[],
  ctx: CapacityPolicyContext,
  policy: CapacityPolicy,
  providerPorts: CapacityPolicyPorts<T> = {
    fairness: (items, activePolicy) => applyProjectFairness(items, activePolicy),
    score: (item, now, activePolicy) => scoreCandidate(item, now, activePolicy),
    capacity: (counts, item, activePolicy) => checkCapacity(counts, item, activePolicy),
    starvation: (items, now, activePolicy) => applyStarvationProtection(items, now, activePolicy),
  } as CapacityPolicyPorts<T>,
): CapacityPolicyResult<T> {
  const validatedPolicy = capacityPolicySchema.parse(policy);
  const effectivePolicy = { ...DEFAULT_CAPACITY_POLICY, ...validatedPolicy };
  const base = orderSwarmQueueCandidates(candidates, { ...ctx.queueOptions, now: new Date(ctx.now) });
  if (!effectivePolicy.enabled) return { ordered: base, rejected: [] };

  const eligible: T[] = [];
  const rejected: RejectedCapacityCandidate<T>[] = [];
  const metrics: CapacityMetrics = {
    activeByProject: ctx.activeByProject,
    activeByCaste: ctx.activeByCaste,
    queuedByProject: {},
    queueDepth: candidates.length,
  };
  for (const candidate of base) {
    const decision = providerPorts.capacity(metrics, candidate, effectivePolicy);
    if (decision.allowed) eligible.push(candidate);
    else if (decision.reason !== "allowed") rejected.push({ id: candidate.issueId, candidate, reason: decision.reason });
  }
  const fair = providerPorts.fairness(eligible, effectivePolicy);
  const scored = [...fair].sort((left, right) => {
    const priorityDelta = swarmPriorityRank(left.priority) - swarmPriorityRank(right.priority);
    if (priorityDelta) return priorityDelta;
    return providerPorts.score(right, ctx.now, effectivePolicy) - providerPorts.score(left, ctx.now, effectivePolicy);
  });
  const starvationOrdered = providerPorts.starvation(scored, ctx.now, effectivePolicy);
  // Fairness must remain the final tie-break for candidates with equal effective priority.
  const fairPosition = new Map(fair.map((candidate, index) => [candidate.issueId, index]));
  const rank = (candidate: T) => {
    const createdAtMs = candidate.createdAt != null ? new Date(candidate.createdAt).getTime() : 0;
    const ageMs = Math.max(0, new Date(ctx.now).getTime() - createdAtMs);
    const baseRank = swarmPriorityRank(candidate.priority);
    return ageMs >= effectivePolicy.starvation.afterMin * 60_000
      ? Math.max(0, baseRank - effectivePolicy.starvation.promoteBy)
      : baseRank;
  };

  return {
    ordered: starvationOrdered.sort((left, right) => {
      const priorityDelta = rank(left) - rank(right);
      if (priorityDelta) return priorityDelta;
      return (fairPosition.get(left.issueId) ?? 0) - (fairPosition.get(right.issueId) ?? 0);
    }),
    rejected,
  };
}
