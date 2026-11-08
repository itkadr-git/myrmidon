// packages/shared/src/myrmidon/run-outcome.test.ts

import { describe, expect, it } from "vitest";
import {
  RUN_OUTCOME_VALUES,
  RUN_STOP_KINDS,
  parseRunOutcome,
  runOutcomeContractSchema,
  safeParseRunOutcome,
} from "./run-outcome.js";

describe("myrmidon(OPE-12314) RunOutcome + stopKind contract", () => {
  it("defines all 5 valid run outcome values", () => {
    expect(RUN_OUTCOME_VALUES).toEqual([
      "success",
      "partial_success",
      "blocked",
      "failed",
      "unknown",
    ]);
  });

  it("defines iteration_limit and budget_limit as distinct stop kinds", () => {
    expect(RUN_STOP_KINDS).toEqual(["iteration_limit", "budget_limit"]);
    expect(RUN_STOP_KINDS[0]).not.toBe(RUN_STOP_KINDS[1]);
  });

  it("validates valid run outcome payloads with all outcomes and stop kinds", () => {
    const validPayloads = [
      {
        schema: "paperclip.run_outcome.v1",
        outcome: "success",
        stopKind: null,
        summary: "Run completed successfully",
      },
      {
        schema: "paperclip.run_outcome.v1",
        outcome: "partial_success",
        stopKind: null,
        summary: "Run completed with partial success",
      },
      {
        schema: "paperclip.run_outcome.v1",
        outcome: "blocked",
        stopKind: "iteration_limit",
        summary: "Run stopped due to iteration limit reached",
      },
      {
        schema: "paperclip.run_outcome.v1",
        outcome: "failed",
        stopKind: "budget_limit",
        summary: "Run failed due to budget limit exceeded",
      },
      {
        schema: "paperclip.run_outcome.v1",
        outcome: "unknown",
        stopKind: null,
        summary: "Run outcome unknown",
      },
    ];

    for (const payload of validPayloads) {
      const parsed = parseRunOutcome(payload);
      expect(parsed).toEqual(payload);
      expect(safeParseRunOutcome(payload).success).toBe(true);
    }
  });

  it("rejects invalid outcome values", () => {
    const invalid = {
      schema: "paperclip.run_outcome.v1",
      outcome: "super_success",
      stopKind: null,
      summary: "Invalid outcome",
    };
    expect(safeParseRunOutcome(invalid).success).toBe(false);
    expect(() => parseRunOutcome(invalid)).toThrow();
  });

  it("rejects invalid stopKind values", () => {
    const invalid = {
      schema: "paperclip.run_outcome.v1",
      outcome: "blocked",
      stopKind: "time_limit",
      summary: "Invalid stop kind",
    };
    expect(safeParseRunOutcome(invalid).success).toBe(false);
    expect(() => parseRunOutcome(invalid)).toThrow();
  });

  it("rejects missing or empty summary (summary is required)", () => {
    const missingSummary = {
      schema: "paperclip.run_outcome.v1",
      outcome: "success",
      stopKind: null,
      summary: "",
    };
    expect(safeParseRunOutcome(missingSummary).success).toBe(false);
    expect(() => parseRunOutcome(missingSummary)).toThrow();

    const noSummary = {
      schema: "paperclip.run_outcome.v1",
      outcome: "success",
      stopKind: null,
    };
    expect(safeParseRunOutcome(noSummary).success).toBe(false);
  });

  it("rejects invalid schema literal", () => {
    const invalidSchema = {
      schema: "wrong.schema.v1",
      outcome: "success",
      stopKind: null,
      summary: "Wrong schema",
    };
    expect(safeParseRunOutcome(invalidSchema).success).toBe(false);
  });
});
