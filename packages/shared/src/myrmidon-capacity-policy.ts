import { z } from "zod";

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

export interface CapacityMetrics {
  activeByProject: Readonly<Record<string, number>>;
  activeByCaste: Readonly<Record<string, number>>;
  queuedByProject: Readonly<Record<string, number>>;
  queueDepth: number;
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
