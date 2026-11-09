// packages/shared/src/myrmidon/run-outcome.ts
//
// OPE-12314 (OPE-12137 ч.1): RunOutcome and stopKind contract in shared.
// Defines RunOutcome type, the `paperclip.run_outcome.v1` contract schema,
// and run outcome validation.

import { z } from "zod";

export type RunOutcomeValue =
  | "success"
  | "partial_success"
  | "blocked"
  | "failed"
  | "unknown";

export const RUN_OUTCOME_VALUES = [
  "success",
  "partial_success",
  "blocked",
  "failed",
  "unknown",
] as const;

export const runOutcomeValueSchema = z.enum(RUN_OUTCOME_VALUES);

export const RUN_STOP_KINDS = ["iteration_limit", "budget_limit"] as const;

export type RunStopKind = (typeof RUN_STOP_KINDS)[number];

export const runStopKindSchema = z.enum(RUN_STOP_KINDS).nullable();

export const runOutcomeContractSchema = z
  .object({
    schema: z.literal("paperclip.run_outcome.v1"),
    outcome: runOutcomeValueSchema,
    stopKind: runStopKindSchema,
    summary: z.string().min(1, "summary must not be empty"),
  })
  .strict();

export type RunOutcomeContract = z.infer<typeof runOutcomeContractSchema>;

export function parseRunOutcome(raw: unknown): RunOutcomeContract {
  return runOutcomeContractSchema.parse(raw);
}

export function safeParseRunOutcome(raw: unknown) {
  return runOutcomeContractSchema.safeParse(raw);
}
