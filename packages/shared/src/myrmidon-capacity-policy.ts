import { z } from "zod";
import { orderSwarmQueueCandidates, swarmPriorityRank, type SwarmQueueCandidate } from "./myrmidon-swarm-claim.js";

const shareSchema = z.number().finite().min(0).max(1);
const nonNegativeNumberSchema = z.number().finite().min(0);
const nonNegativeIntegerSchema = z.number().int().min(0);

export const capacityPolicySchema = z.object({
  enabled: z.boolean().default(false),
  fairness: z.object({ perProjectMaxShare: shareSchema }).default({ perProjectMaxShare: 0.5 }),
  aging: z.object({
    halfLifeMin: nonNegativeNumberSchema,
    maxBoost: nonNegativeNumberSchema,
  }).default({ halfLifeMin: 60, maxBoost: 1 }),
  limits: z.object({
    perProjectActive: nonNegativeIntegerSchema.nullable(),
    perCasteActive: nonNegativeIntegerSchema.nullable(),
  }).default({ perProjectActive: null, perCasteActive: null }),
  starvation: z.object({
    afterMin: nonNegativeNumberSchema,
    promoteBy: nonNegativeIntegerSchema,
  }).default({ afterMin: 60, promoteBy: 1 }),
}).strict();

export type CapacityPolicy = z.infer<typeof capacityPolicySchema>;

export type CapacityPolicyPatch = {
  enabled?: boolean;
  fairness?: Partial<CapacityPolicy["fairness"]>;
  aging?: Partial<CapacityPolicy["aging"]>;
  limits?: Partial<CapacityPolicy["limits"]>;
  starvation?: Partial<CapacityPolicy["starvation"]>;
};

export const capacityPolicyPatchSchema = z.object({
  enabled: z.boolean().optional(),
  fairness: z.object({ perProjectMaxShare: shareSchema.optional() }).strict().optional(),
  aging: z.object({
    halfLifeMin: nonNegativeNumberSchema.optional(),
    maxBoost: nonNegativeNumberSchema.optional(),
  }).strict().optional(),
  limits: z.object({
    perProjectActive: nonNegativeIntegerSchema.nullable().optional(),
    perCasteActive: nonNegativeIntegerSchema.nullable().optional(),
  }).strict().optional(),
  starvation: z.object({
    afterMin: nonNegativeNumberSchema.optional(),
    promoteBy: nonNegativeIntegerSchema.optional(),
  }).strict().optional(),
}).strict();

export const DEFAULT_CAPACITY_POLICY: CapacityPolicy = {
  enabled: false,
  fairness: { perProjectMaxShare: 0.5 },
  aging: { halfLifeMin: 60, maxBoost: 1 },
  limits: { perProjectActive: null, perCasteActive: null },
  starvation: { afterMin: 60, promoteBy: 1 },
};

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
    const index = remaining.findIndex((candidate) => {
      const project = candidate.projectId?.trim();
      if (!project) return true;
      return (counts.get(project) ?? 0) + 1 <= Math.ceil((result.length + 1) * maxShare);
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
    const createdAtMs = candidate.createdAt != null ? new Date(candidate.createdAt).getTime() : 0;
    const ageMs = Math.max(0, nowMs - createdAtMs);
    const baseRank = swarmPriorityRank(candidate.priority);
    return ageMs >= policy.starvation.afterMin * 60_000
      ? Math.max(0, baseRank - policy.starvation.promoteBy)
      : baseRank;
  };
  return [...candidates].sort((left, right) => {
    const rankDelta = rank(left) - rank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAtMs = left.createdAt != null ? new Date(left.createdAt).getTime() : 0;
    const rightCreatedAtMs = right.createdAt != null ? new Date(right.createdAt).getTime() : 0;
    const ageDelta = leftCreatedAtMs - rightCreatedAtMs;
    return ageDelta || candidates.indexOf(left) - candidates.indexOf(right);
  });
}

/** Validate a partial update, then apply it without replacing untouched sections. */
export function mergeCapacityPolicyPatch(
  current: CapacityPolicy = DEFAULT_CAPACITY_POLICY,
  patch: unknown,
): CapacityPolicy {
  const validPatch = capacityPolicyPatchSchema.parse(patch);
  return capacityPolicySchema.parse({
    ...current,
    ...validPatch,
    fairness: { ...current.fairness, ...validPatch.fairness },
    aging: { ...current.aging, ...validPatch.aging },
    limits: { ...current.limits, ...validPatch.limits },
    starvation: { ...current.starvation, ...validPatch.starvation },
  });
}
