import { describe, expect, it } from "vitest";

import {
  RUN_OUTCOME_SCHEMA,
  RUN_OUTCOME_STOP_KINDS,
  type RunOutcome,
  type RunOutcomeContract,
  type RunStopKind,
} from "./heartbeat.js";
import {
  runOutcomeContractSchema,
  runOutcomeSchema,
  runStopKindSchema,
} from "../validators/run-outcome.js";

const ALL_OUTCOMES: readonly RunOutcome[] = [
  "success",
  "partial_success",
  "blocked",
  "failed",
  "unknown",
];

const canonicalContract: RunOutcomeContract = {
  schema: RUN_OUTCOME_SCHEMA,
  outcome: "success",
  stopKind: null,
  summary: "Run finished cleanly.",
};

describe("run outcome contract type surface (types/heartbeat.ts)", () => {
  it("pins the schema literal", () => {
    expect(RUN_OUTCOME_SCHEMA).toBe("paperclip.run_outcome.v1");
    expect(canonicalContract.schema).toBe(RUN_OUTCOME_SCHEMA);
  });

  it("keeps the outcome union closed over exactly five codes", () => {
    expect([...RUN_OUTCOME_STOP_KINDS]).toEqual([
      "iteration_limit",
      "budget_limit",
    ]);
    for (const outcome of ALL_OUTCOMES) {
      const contract: RunOutcomeContract = {
        ...canonicalContract,
        outcome,
      };
      expect(contract.outcome).toBe(outcome);
    }
  });

  it("keeps iteration_limit and budget_limit distinct stop kinds", () => {
    const iterationStop: RunStopKind = "iteration_limit";
    const budgetStop: RunStopKind = "budget_limit";
    expect(iterationStop).not.toBe(budgetStop);
    expect(RUN_OUTCOME_STOP_KINDS).toContain(iterationStop);
    expect(RUN_OUTCOME_STOP_KINDS).toContain(budgetStop);
    expect(RUN_OUTCOME_STOP_KINDS).toHaveLength(2);
  });

  it("allows null stopKind for non-cap stops and rejects conflated kinds", () => {
    const naturalFinish: RunOutcomeContract = {
      ...canonicalContract,
      stopKind: null,
    };
    expect(naturalFinish.stopKind).toBeNull();

    const roundTrip = runOutcomeContractSchema.parse(canonicalContract);
    expect(roundTrip).toEqual(canonicalContract);
    expect(() =>
      runOutcomeContractSchema.parse({
        ...canonicalContract,
        outcome: "succeeded",
      }),
    ).toThrow();
    expect(() =>
      runOutcomeContractSchema.parse({
        ...canonicalContract,
        stopKind: "money_limit",
      }),
    ).toThrow();
  });

  it("keeps zod validators in parity with the TypeScript unions", () => {
    // Compile-time parity: widening either union must re-type the const list.
    const outcomeList: readonly RunOutcome[] = runOutcomeSchema.options;
    const stopKindList: readonly RunStopKind[] = runStopKindSchema.options;
    expect(outcomeList).toEqual([...ALL_OUTCOMES]);
    expect(stopKindList).toEqual([...RUN_OUTCOME_STOP_KINDS]);

    // A stop-kind misspelling must fail the schema at runtime...
    expect(runStopKindSchema.safeParse("ITERATION_LIMIT").success).toBe(false);
    // ...and must not be assignable to the RunStopKind type.
    const misspelled = "ITERATION_LIMIT";
    const misspelledIsNotStopKind = (
      candidate: string,
    ): candidate is RunStopKind =>
      (RUN_OUTCOME_STOP_KINDS as readonly string[]).includes(candidate);
    expect(misspelledIsNotStopKind(misspelled)).toBe(false);
  });

  it("summarizes runs with distinct caps without losing the cap identity", () => {
    const iteration: RunOutcomeContract = {
      schema: RUN_OUTCOME_SCHEMA,
      outcome: "partial_success",
      stopKind: "iteration_limit",
      summary: "Stopped at the iteration cap with partial work done.",
    };
    const budget: RunOutcomeContract = {
      schema: RUN_OUTCOME_SCHEMA,
      outcome: "partial_success",
      stopKind: "budget_limit",
      summary: "Stopped at the budget cap with partial work done.",
    };

    // Same outcome code, same schema — the cap identity must survive parsing.
    const parsedIteration = runOutcomeContractSchema.parse(iteration);
    const parsedBudget = runOutcomeContractSchema.parse(budget);
    expect(parsedIteration.outcome).toBe(parsedBudget.outcome);
    expect(parsedIteration.stopKind).not.toBe(parsedBudget.stopKind);
    expect(parsedIteration.stopKind).toBe("iteration_limit");
    expect(parsedBudget.stopKind).toBe("budget_limit");
  });
});
