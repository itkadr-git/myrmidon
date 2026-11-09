import { describe, expect, it } from "vitest";

import {
  RUN_OUTCOME_SCHEMA,
  RUN_OUTCOME_STOP_KINDS,
  type RunOutcome,
  type RunStopKind,
} from "../types/heartbeat.js";
import {
  runOutcomeContractSchema,
  runOutcomeSchema,
  runStopKindSchema,
} from "./run-outcome.js";

const ALL_OUTCOMES: readonly RunOutcome[] = [
  "success",
  "partial_success",
  "blocked",
  "failed",
  "unknown",
];

const baseContract = {
  schema: RUN_OUTCOME_SCHEMA,
  outcome: "success",
  stopKind: null,
  summary: "Run finished cleanly.",
} as const;

describe("runOutcomeSchema", () => {
  it("accepts all five outcome codes", () => {
    for (const outcome of ALL_OUTCOMES) {
      expect(runOutcomeSchema.safeParse(outcome).success).toBe(true);
    }
    expect(runOutcomeSchema.options).toEqual([...ALL_OUTCOMES]);
  });

  it("rejects garbage outcome codes", () => {
    for (const garbage of [
      "ok",
      "SUCCESS",
      "partial",
      "succeeded",
      "completed",
      "error",
      "",
      42,
      null,
      undefined,
    ]) {
      expect(runOutcomeSchema.safeParse(garbage).success).toBe(false);
    }
  });
});

describe("runStopKindSchema", () => {
  it("accepts both stop kinds and null", () => {
    expect(runStopKindSchema.safeParse("iteration_limit").success).toBe(true);
    expect(runStopKindSchema.safeParse("budget_limit").success).toBe(true);
    expect(RUN_OUTCOME_STOP_KINDS).toEqual(["iteration_limit", "budget_limit"]);
  });

  it("rejects garbage and conflated stop kinds", () => {
    for (const garbage of [
      "limit",
      "iteration",
      "budget",
      "time_limit",
      "cancelled",
      "ITERATION_LIMIT",
      "",
      null,
      0,
    ]) {
      expect(runStopKindSchema.safeParse(garbage).success).toBe(false);
    }
  });
});

describe("runOutcomeContractSchema", () => {
  it("accepts the canonical contract with stopKind null", () => {
    const parsed = runOutcomeContractSchema.parse(baseContract);
    expect(parsed).toEqual(baseContract);
    expect(parsed.schema).toBe("paperclip.run_outcome.v1");
  });

  it("accepts every outcome code in a full contract", () => {
    for (const outcome of ALL_OUTCOMES) {
      expect(
        runOutcomeContractSchema.safeParse({ ...baseContract, outcome }).success,
      ).toBe(true);
    }
  });

  it("keeps iteration_limit and budget_limit distinguishable", () => {
    const iterationStop = runOutcomeContractSchema.parse({
      ...baseContract,
      outcome: "partial_success",
      stopKind: "iteration_limit",
      summary: "Stopped at the iteration cap with partial work done.",
    });
    const budgetStop = runOutcomeContractSchema.parse({
      ...baseContract,
      outcome: "partial_success",
      stopKind: "budget_limit",
      summary: "Stopped at the budget cap with partial work done.",
    });

    // Same outcome, same summary shape — the stop kind must still differ.
    expect(iterationStop.outcome).toBe(budgetStop.outcome);
    expect(iterationStop.stopKind).not.toBe(budgetStop.stopKind);
    expect(iterationStop.stopKind).toBe("iteration_limit");
    expect(budgetStop.stopKind).toBe("budget_limit");
  });

  it("rejects a contract without summary (outcome alone is not enough)", () => {
    const { summary: _summary, ...withoutSummary } = baseContract;
    const result = runOutcomeContractSchema.safeParse(withoutSummary);
    expect(result.success).toBe(false);
  });

  it("rejects empty, whitespace-only and non-string summaries", () => {
    for (const summary of ["", "   ", "\n\t", null, 123]) {
      expect(
        runOutcomeContractSchema.safeParse({ ...baseContract, summary }).success,
      ).toBe(false);
    }
  });

  it("rejects garbage outcome and stopKind values in the contract", () => {
    expect(
      runOutcomeContractSchema.safeParse({
        ...baseContract,
        outcome: "succeeded",
      }).success,
    ).toBe(false);
    expect(
      runOutcomeContractSchema.safeParse({
        ...baseContract,
        outcome: "success",
        stopKind: "money_limit",
      }).success,
    ).toBe(false);
  });

  it("rejects wrong schema literal and extra fields (strict)", () => {
    expect(
      runOutcomeContractSchema.safeParse({
        ...baseContract,
        schema: "paperclip.run_outcome.v2",
      }).success,
    ).toBe(false);
    expect(
      runOutcomeContractSchema.safeParse({
        ...baseContract,
        stopReason: "iteration_limit",
      }).success,
    ).toBe(false);
  });
});

describe("run outcome stop-kind type surface", () => {
  it("exposes exactly the two distinct stop kinds as a type", () => {
    const kinds: readonly RunStopKind[] = ["iteration_limit", "budget_limit"];
    expect(kinds).toEqual(RUN_OUTCOME_STOP_KINDS);
  });
});
