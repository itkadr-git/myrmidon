import { z } from "zod";

export interface BlockerRootFanout {
  rootIssueId: string;
  rootIdentifier: string;
  rootStatus: string;
  dependentCount: number;
  dependents: string[];
  oldestBlockedAt: string | null;
  hasMissingFields: boolean;
}

export interface BlockerGraphRootsResponse {
  roots: BlockerRootFanout[];
  limit: number;
  generatedAt: string;
}

export interface BlockerGraphMetrics {
  rootCount: number;
  dependentCount: number;
  rootsWithMissingFields: number;
}

export const DEFAULT_ROOT_FANOUT_LIMIT = 100;

export const blockerRootFanoutSchema = z.object({
  rootIssueId: z.string().min(1),
  rootIdentifier: z.string().min(1),
  rootStatus: z.string().min(1),
  dependentCount: z.number().int().nonnegative(),
  dependents: z.array(z.string().min(1)),
  oldestBlockedAt: z.string().datetime().nullable(),
  hasMissingFields: z.boolean(),
});

export const blockerGraphRootsResponseSchema = z.object({
  roots: z.array(blockerRootFanoutSchema),
  limit: z.number().int().positive(),
  generatedAt: z.string().datetime(),
});
