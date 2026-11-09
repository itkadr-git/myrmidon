import { z } from "zod";

import {
  RUN_OUTCOME_SCHEMA,
  RUN_OUTCOME_STOP_KINDS,
  type RunOutcome,
  type RunStopKind,
} from "../types/heartbeat.js";

export const runOutcomeSchema = z.enum([
  "success",
  "partial_success",
  "blocked",
  "failed",
  "unknown",
]);

export const runStopKindSchema = z.enum([
  "iteration_limit",
  "budget_limit",
] as const);

export const runOutcomeContractSchema = z
  .object({
    schema: z.literal(RUN_OUTCOME_SCHEMA),
    outcome: runOutcomeSchema,
    /**
     * Which execution bound ended the run: iteration_limit for the iteration
     * cap, budget_limit for the budget cap. `null` when the run ended for any
     * other reason (completed work, failure, cancellation, unknown) — the two
     * limit kinds must stay distinguishable from each other and from ordinary
     * completions.
     */
    stopKind: runStopKindSchema.nullable(),
    summary: z.string().trim().min(1),
  })
  .strict();

export type RunOutcomeInput = z.infer<typeof runOutcomeSchema>;
export type RunStopKindInput = z.infer<typeof runStopKindSchema>;
export type RunOutcomeContractInput = z.infer<typeof runOutcomeContractSchema>;

// Runtime parity checks: the zod enums and the TypeScript union types must
// never drift apart. The stop-kind enum must match the exported
// RUN_OUTCOME_STOP_KINDS order exactly.
const _outcomeParity: readonly RunOutcome[] = runOutcomeSchema.options;
const _stopKindParity: readonly RunStopKind[] = runStopKindSchema.options;
const _stopKindListParity: readonly RunStopKind[] = RUN_OUTCOME_STOP_KINDS;
void _outcomeParity;
void _stopKindParity;
void _stopKindListParity;

export type { RunOutcome, RunStopKind };
