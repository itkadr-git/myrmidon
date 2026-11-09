import { z } from "zod";

/** Conservative per-run memory estimate used when deriving a container-safe cap. */
export const DEFAULT_RUN_MEMORY_MB = 600;

export interface EffectiveAgentRunLimitInput {
  boardLimit: number;
  gatewayLimit?: number | null;
  memoryMb?: number | null;
  runMemoryMb?: number;
}

/** Read the same saved ceilings for admission and for the agent card. */
export function savedAgentRunLimits(input: {
  boardLimit: number;
  adapterConfig: Record<string, unknown> | null | undefined;
}): EffectiveAgentRunLimitInput {
  const config = input.adapterConfig ?? {};
  const container = asRecord(config.container);
  const gateway = asRecord(config.gateway);
  const number = (value: unknown): number | null => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  return {
    boardLimit: input.boardLimit,
    gatewayLimit: number(container.maxConcurrentRuns ?? container.max_concurrent_runs ?? gateway.maxConcurrentRuns ?? gateway.max_concurrent_runs),
    memoryMb: number(container.memoryMb),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Return the cap an agent may actually consume. A missing gateway or memory
 * limit means that ceiling is not known and is not applied.
 */
export type EffectiveAgentRunLimitSource = "board" | "gateway" | "memory";

export function effectiveAgentRunLimitSource(input: EffectiveAgentRunLimitInput): EffectiveAgentRunLimitSource {
  const memoryCeiling = input.memoryMb == null || (input.runMemoryMb ?? DEFAULT_RUN_MEMORY_MB) <= 0
    ? Number.POSITIVE_INFINITY
    : Math.floor(input.memoryMb / (input.runMemoryMb ?? DEFAULT_RUN_MEMORY_MB));
  if (input.gatewayLimit != null && input.gatewayLimit <= Math.min(input.boardLimit, memoryCeiling)) return "gateway";
  if (memoryCeiling < input.boardLimit) return "memory";
  return "board";
}

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
