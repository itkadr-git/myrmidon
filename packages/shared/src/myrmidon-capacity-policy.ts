import { orderSwarmQueueCandidates, swarmPriorityRank, type SwarmQueueCandidate } from "./myrmidon-swarm-claim.js";
import {
  DEFAULT_CAPACITY_POLICY,
  type CapacityPolicy,
} from "./myrmidon-capacity-policy-schema.js";

export * from "./myrmidon-capacity-policy-schema.js";

/** Reorders the queue to cap each project's share while preserving base order. */
export function applyProjectFairness<T extends SwarmQueueCandidate & { projectId?: string | null }>(
  candidates: readonly T[],
  policy: CapacityPolicy,
): T[] {
  const ordered = orderSwarmQueueCandidates(candidates);
  const maxShare = policy.fairness.perProjectMaxShare;
  if (ordered.length < 2 || maxShare >= 1) return ordered;

  const result: T[] = [];
  const remaining = [...ordered];
  const counts = new Map<string, number>();
  while (remaining.length) {
    const nextLength = result.length + 1;
    const index = remaining.findIndex((candidate) => {
      const project = candidate.projectId?.trim();
      if (!project) return true;
      return (counts.get(project) ?? 0) + 1 <= Math.ceil(nextLength * maxShare);
    });
    const [candidate] = remaining.splice(index < 0 ? 0 : index, 1);
    result.push(candidate);
    const project = candidate.projectId?.trim();
    if (project) counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  return result;
}

export interface CapacityMetrics {
  activeByProject: Readonly<Record<string, number>>;
  activeByCaste: Readonly<Record<string, number>>;
  queuedByProject: Readonly<Record<string, number>>;
  queueDepth: number;
}

export interface CapacityCandidate {
  priority?: string | null;
  createdAt?: Date | string | number;
  projectId?: string | null;
  casteId?: string | null;
}

export type CapacityDecisionReason = "allowed" | "project_limit" | "caste_limit";

export interface CapacityDecision {
  allowed: boolean;
  reason: CapacityDecisionReason;
}

/** Check the candidate against current project and caste active-task counts. */
export function checkCapacity(
  activeCounts: Pick<CapacityMetrics, "activeByProject" | "activeByCaste">,
  candidate: CapacityCandidate,
  policy: CapacityPolicy,
): CapacityDecision {
  const { perProjectActive, perCasteActive } = policy.limits;
  if (
    perProjectActive !== null
    && candidate.projectId != null
    && (activeCounts.activeByProject[candidate.projectId] ?? 0) >= perProjectActive
  ) {
    return { allowed: false, reason: "project_limit" };
  }
  if (
    perCasteActive !== null
    && candidate.casteId != null
    && (activeCounts.activeByCaste[candidate.casteId] ?? 0) >= perCasteActive
  ) {
    return { allowed: false, reason: "caste_limit" };
  }
  return { allowed: true, reason: "allowed" };
}

/** Priority establishes the band; capped exponential aging only breaks ties gradually. */
export function scoreCandidate(
  candidate: CapacityCandidate,
  now: Date | string | number,
  policy: CapacityPolicy = DEFAULT_CAPACITY_POLICY,
): number {
  const priorityScore = Math.max(0, 4 - swarmPriorityRank(candidate.priority));
  const ageMs = candidate.createdAt === undefined
    ? 0
    : Math.max(0, new Date(now).getTime() - new Date(candidate.createdAt).getTime());
  const ageMinutes = ageMs / 60_000;
  const { halfLifeMin, maxBoost } = policy.aging;
  const boost = halfLifeMin === 0
    ? (ageMinutes > 0 ? maxBoost : 0)
    : maxBoost * (1 - Math.pow(0.5, ageMinutes / halfLifeMin));
  return priorityScore + Math.min(maxBoost, boost);
}

/** Promote candidates that crossed the wait threshold by `promoteBy` priority bands. */
export function applyStarvationProtection<T extends CapacityCandidate>(
  candidates: readonly T[],
  now: Date | string | number,
  policy: CapacityPolicy = DEFAULT_CAPACITY_POLICY,
): T[] {
  const nowMs = new Date(now).getTime();
  const rank = (candidate: T) => {
    const ageMs = candidate.createdAt === undefined
      ? 0
      : Math.max(0, nowMs - new Date(candidate.createdAt).getTime());
    const baseRank = swarmPriorityRank(candidate.priority);
    return ageMs >= policy.starvation.afterMin * 60_000
      ? Math.max(0, baseRank - policy.starvation.promoteBy)
      : baseRank;
  };
  return [...candidates].sort((left, right) => {
    const rankDelta = rank(left) - rank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAtMs = left.createdAt === undefined ? nowMs : new Date(left.createdAt).getTime();
    const rightCreatedAtMs = right.createdAt === undefined ? nowMs : new Date(right.createdAt).getTime();
    const ageDelta = leftCreatedAtMs - rightCreatedAtMs;
    return ageDelta || candidates.indexOf(left) - candidates.indexOf(right);
  });
}
