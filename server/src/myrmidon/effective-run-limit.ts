import { z } from "zod";

/** Conservative per-run memory estimate used when deriving a container-safe cap. */
export const DEFAULT_RUN_MEMORY_MB = 600;

export interface EffectiveAgentRunLimitInput {
  boardLimit: number;
  gatewayLimit?: number | null;
  memoryMb?: number | null;
  runMemoryMb?: number;
}

/**
 * Return the cap an agent may actually consume. A missing gateway or memory
 * limit means that ceiling is not known and is not applied.
 */
export function effectiveAgentRunLimit(input: EffectiveAgentRunLimitInput): number {
  const ceilings = [input.boardLimit];
  if (input.gatewayLimit != null && Number.isFinite(input.gatewayLimit)) ceilings.push(input.gatewayLimit);
  if (input.memoryMb != null && Number.isFinite(input.memoryMb)) {
    const perRun = input.runMemoryMb ?? DEFAULT_RUN_MEMORY_MB;
    if (perRun > 0) ceilings.push(Math.floor(input.memoryMb / perRun));
  }
  return Math.max(0, Math.floor(Math.min(...ceilings)));
}

export const effectiveAgentRunLimitSchema = z.object({
  boardLimit: z.number().int().nonnegative(),
  gatewayLimit: z.number().int().positive().nullable().optional(),
  memoryMb: z.number().positive().nullable().optional(),
  runMemoryMb: z.number().positive().optional(),
});
