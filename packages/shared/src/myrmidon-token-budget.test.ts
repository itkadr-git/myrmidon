// myrmidon(1.7 TOKEN-BUDGET-SIGNAL, OPE-12232): the shared contract of the
// issue token budget — a SIGNAL, never a limit.
//
// The acceptance criteria pinned here: a token amount past 100% of the budget
// still yields a plain "warn" level — no pause state, no pauseReason, no run
// refusal flag anywhere in the payload (enforcement is the contract literal
// "signal") — and the level thresholds follow the epic (warn ~80%, info below).

import { describe, expect, it } from "vitest";
import {
  TOKEN_BUDGET_SIGNAL_DEFAULT_INFO_PERCENT,
  TOKEN_BUDGET_SIGNAL_LEVELS,
  buildTokenBudgetSignal,
  tokenBudgetSignalLevel,
  tokenBudgetSignalSchema,
} from "./myrmidon-token-budget.js";

describe("token budget signal levels", () => {
  it("stays quiet without a budget or without spend", () => {
    expect(tokenBudgetSignalLevel(0, 1000)).toBe("none");
    expect(tokenBudgetSignalLevel(500, 0)).toBe("none");
    expect(tokenBudgetSignalLevel(500, -5)).toBe("none");
  });

  it("warns at ~80% (the policy warnPercent, inclusive) and past 100%", () => {
    // The default info percent (50) applies below the warn threshold.
    expect(tokenBudgetSignalLevel(799, 1000, 80)).toBe("info");
    expect(tokenBudgetSignalLevel(800, 1000, 80)).toBe("warn");
    expect(tokenBudgetSignalLevel(1000, 1000, 80)).toBe("warn");
    // The acceptance edge: OVER the budget — still just a signal, never a stop.
    expect(tokenBudgetSignalLevel(5000, 1000, 80)).toBe("warn");
  });

  it("gives info between the info percent and the warn threshold", () => {
    expect(tokenBudgetSignalLevel(499, 1000, 80, 50)).toBe("none");
    expect(tokenBudgetSignalLevel(500, 1000, 80, 50)).toBe("info");
    expect(tokenBudgetSignalLevel(799, 1000, 80, 50)).toBe("info");
  });

  it("warn wins over info when both thresholds are met", () => {
    expect(tokenBudgetSignalLevel(900, 1000, 80, 50)).toBe("warn");
  });
});

describe("token budget signal builder", () => {
  it("carries the never-enforcing contract: enforcement is 'signal', scope is the issue", () => {
    const signal = buildTokenBudgetSignal({
      policyId: "policy-1",
      scopeId: "issue-1",
      amountTokens: 1000,
      observedTokens: 850,
      warnPercent: 80,
    });
    expect(signal.enforcement).toBe("signal");
    expect(signal.scopeType).toBe("issue");
    expect(signal.metric).toBe("issue_tokens");
    expect(signal.level).toBe("warn");
    expect(signal.utilizationPercent).toBe(85);
    expect(signal).toEqual(
      tokenBudgetSignalSchema.parse(signal),
    );
  });

  it("reports utilization past 100% without any pause semantics", () => {
    const signal = buildTokenBudgetSignal({
      policyId: "policy-1",
      scopeId: "issue-1",
      amountTokens: 1000,
      observedTokens: 2500,
    });
    expect(signal.utilizationPercent).toBe(250);
    expect(signal.level).toBe("warn");
    expect(signal.enforcement).toBe("signal");
    const parsed = tokenBudgetSignalSchema.parse(signal);
    expect(parsed).toEqual(signal);
  });

  it("uses the default info percent and zero utilization without a budget", () => {
    expect(TOKEN_BUDGET_SIGNAL_DEFAULT_INFO_PERCENT).toBe(50);
    expect(TOKEN_BUDGET_SIGNAL_LEVELS).toEqual(["none", "info", "warn"]);
    const quiet = buildTokenBudgetSignal({
      policyId: "policy-1",
      scopeId: "issue-1",
      amountTokens: 0,
      observedTokens: 0,
    });
    expect(quiet.level).toBe("none");
    expect(quiet.utilizationPercent).toBe(0);
  });
});
