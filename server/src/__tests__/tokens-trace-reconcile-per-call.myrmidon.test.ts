import { describe, expect, it } from "vitest";
import { findPerCallMismatches } from "../myrmidon/tokens-trace/per-call-reconcile.js";

describe("findPerCallMismatches (acceptance #2 per-call rule)", () => {
  it("passes calls whose prompt tokens agree within 5%", () => {
    const rows = [
      { litellmRequestId: "req-1", tracePromptTokens: 1000, spendLogPromptTokens: 1020 },
      { litellmRequestId: "req-2", tracePromptTokens: 500, spendLogPromptTokens: 500 },
      // Exactly at the 5% boundary is not a mismatch (rule: > tolerance).
      { litellmRequestId: "req-3", tracePromptTokens: 950, spendLogPromptTokens: 1000 },
    ];
    expect(findPerCallMismatches(rows)).toEqual([]);
  });

  it("flags calls whose relative prompt-token difference exceeds 5%", () => {
    const rows = [
      { litellmRequestId: "req-ok", tracePromptTokens: 1000, spendLogPromptTokens: 1000 },
      { litellmRequestId: "req-bad", tracePromptTokens: 1100, spendLogPromptTokens: 1000 },
    ];
    const mismatches = findPerCallMismatches(rows);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      litellmRequestId: "req-bad",
      kind: "relative_diff_exceeded",
      tracePromptTokens: 1100,
      spendLogPromptTokens: 1000,
    });
    expect(mismatches[0]!.relativeDiff).toBeCloseTo(0.1);
  });

  it("flags calls with no spend-log row instead of dropping them", () => {
    const rows = [
      { litellmRequestId: "req-orphan", tracePromptTokens: 700, spendLogPromptTokens: null },
    ];
    const mismatches = findPerCallMismatches(rows);
    expect(mismatches).toEqual([
      {
        litellmRequestId: "req-orphan",
        kind: "missing_spend_log",
        tracePromptTokens: 700,
        spendLogPromptTokens: null,
        relativeDiff: null,
      },
    ]);
  });

  it("honours a custom tolerance", () => {
    const rows = [
      { litellmRequestId: "req-2pct", tracePromptTokens: 1020, spendLogPromptTokens: 1000 },
    ];
    expect(findPerCallMismatches(rows, 0.01)).toHaveLength(1);
    expect(findPerCallMismatches(rows, 0.05)).toHaveLength(0);
  });

  it("ignores spend-log rows with zero prompt tokens (no denominator)", () => {
    const rows = [
      { litellmRequestId: "req-zero", tracePromptTokens: 0, spendLogPromptTokens: 0 },
    ];
    expect(findPerCallMismatches(rows)).toEqual([]);
  });
});
