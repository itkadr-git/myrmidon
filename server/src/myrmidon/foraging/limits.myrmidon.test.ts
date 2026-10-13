// myrmidon(1.6.1-FORAGING-LIMITS-UI): the pure rules of the learning limits —
// the window arithmetic (UTC day/month), the limit decision, the ceilings and
// the signal text. No database, no network. Neutral data only.
import { describe, expect, it } from "vitest";
import {
  clearForagingLimitSignal,
  decideForagingLimits,
  foragingAutoOffSignal,
  foragingDailyCeiling,
  foragingLimitSignal,
  readForagingLimitSignal,
  recordForagingLimitSignal,
  resetForagingSignals,
  utcDayStart,
  utcMonthStart,
} from "./limits.js";

const WINDOWS = { dayCents: 0, monthCents: 0 };

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) windows", () => {
  it("starts the UTC day at midnight", () => {
    expect(utcDayStart(new Date("2026-10-03T23:59:59Z")).toISOString()).toBe(
      "2026-10-03T00:00:00.000Z",
    );
    expect(utcDayStart(new Date("2026-10-04T00:00:01Z")).toISOString()).toBe(
      "2026-10-04T00:00:00.000Z",
    );
  });

  it("starts the UTC month at its first midnight", () => {
    expect(utcMonthStart(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(utcMonthStart(new Date("2026-11-01T00:00:01Z")).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) decideForagingLimits", () => {
  it("allows a read when every window has room", () => {
    const decision = decideForagingLimits({
      settings: { dailyBudgetCents: 100, monthlyBudgetCents: 5000, roleBudgetCents: 60, agentBudgetCents: 20 },
      spend: { dayCents: 40, monthCents: 900 },
      role: "smm",
      roleSpentCents: 10,
      agentId: "ag-1",
      agentSpentCents: 5,
      estimateCents: 5,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBeNull();
    expect(decision.reason).toBeNull();
  });

  it("refuses a read that would cross the daily company ceiling", () => {
    const decision = decideForagingLimits({
      settings: { dailyBudgetCents: 100, monthlyBudgetCents: null, roleBudgetCents: null, agentBudgetCents: null },
      spend: { dayCents: 96, monthCents: 0 },
      role: "smm",
      roleSpentCents: 0,
      agentId: null,
      agentSpentCents: 0,
      estimateCents: 5,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe("company_daily");
    expect(decision.reason).toContain("100c");
  });

  it("a read that reaches exactly the ceiling is allowed; the next one refuses", () => {
    const exact = decideForagingLimits({
      settings: { dailyBudgetCents: 100, monthlyBudgetCents: null, roleBudgetCents: null, agentBudgetCents: null },
      spend: { dayCents: 95, monthCents: 0 },
      role: "smm",
      roleSpentCents: 0,
      agentId: null,
      agentSpentCents: 0,
      estimateCents: 5,
    });
    expect(exact.allowed).toBe(true);
    const next = decideForagingLimits({
      settings: { dailyBudgetCents: 100, monthlyBudgetCents: null, roleBudgetCents: null, agentBudgetCents: null },
      spend: { dayCents: 100, monthCents: 0 },
      role: "smm",
      roleSpentCents: 0,
      agentId: null,
      agentSpentCents: 0,
      estimateCents: 1,
    });
    expect(next.allowed).toBe(false);
  });

  it("refuses a read that would cross the monthly company ceiling", () => {
    const decision = decideForagingLimits({
      settings: { dailyBudgetCents: null, monthlyBudgetCents: 5000, roleBudgetCents: null, agentBudgetCents: null },
      spend: { dayCents: 0, monthCents: 4996 },
      role: "smm",
      roleSpentCents: 0,
      agentId: null,
      agentSpentCents: 0,
      estimateCents: 5,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe("company_monthly");
  });

  it("refuses a read that would cross the daily role ceiling", () => {
    const decision = decideForagingLimits({
      settings: { dailyBudgetCents: null, monthlyBudgetCents: null, roleBudgetCents: 60, agentBudgetCents: null },
      spend: { ...WINDOWS },
      role: "smm",
      roleSpentCents: 56,
      agentId: null,
      agentSpentCents: 0,
      estimateCents: 5,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe("role_daily");
    expect(decision.reason).toContain("smm");
  });

  it("refuses a read that would cross the daily agent ceiling", () => {
    const decision = decideForagingLimits({
      settings: { dailyBudgetCents: null, monthlyBudgetCents: null, roleBudgetCents: null, agentBudgetCents: 20 },
      spend: { ...WINDOWS },
      role: "smm",
      roleSpentCents: 0,
      agentId: "ag-1",
      agentSpentCents: 16,
      estimateCents: 5,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe("agent_daily");
  });

  it("the agent ceiling does not apply without an agent", () => {
    const decision = decideForagingLimits({
      settings: { dailyBudgetCents: null, monthlyBudgetCents: null, roleBudgetCents: null, agentBudgetCents: 20 },
      spend: { ...WINDOWS },
      role: "smm",
      roleSpentCents: 0,
      agentId: null,
      agentSpentCents: 0,
      estimateCents: 50,
    });
    expect(decision.allowed).toBe(true);
  });

  it("null ceilings never refuse anything", () => {
    const decision = decideForagingLimits({
      settings: { dailyBudgetCents: null, monthlyBudgetCents: null, roleBudgetCents: null, agentBudgetCents: null },
      spend: { dayCents: 1_000_000, monthCents: 10_000_000 },
      role: "smm",
      roleSpentCents: 999,
      agentId: "ag-1",
      agentSpentCents: 999,
      estimateCents: 999,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) dailyCeiling", () => {
  it("answers the setting or null", () => {
    expect(foragingDailyCeiling({ dailyBudgetCents: 100 })).toBe(100);
    expect(foragingDailyCeiling({ dailyBudgetCents: null })).toBeNull();
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) the attention signal", () => {
  it("builds the hard-mode card from the stop reason", () => {
    const signal = foragingLimitSignal({
      companyId: "co-1",
      reason: "the daily learning limit of 100c was reached (100c spent today)",
      enforcement: "hard",
      activityAt: "2026-10-03T12:00:00.000Z",
    });
    expect(signal.dedupKey).toContain("foraging");
    expect(signal.severity).toBe("high");
    expect(signal.whyNow).toContain("A foraging pass stopped");
    expect(signal.whyNow).not.toContain("Soft mode");
  });

  it("builds the soft-mode card naming the owner's choice", () => {
    const signal = foragingLimitSignal({
      companyId: "co-1",
      reason: "the daily learning limit of 100c was reached",
      enforcement: "soft",
      activityAt: "2026-10-03T12:00:00.000Z",
    });
    expect(signal.whyNow).toContain("raise the limit or switch learning off");
  });

  it("records and clears per company; a pass without a stop clears the card", () => {
    resetForagingSignals();
    recordForagingLimitSignal(
      foragingLimitSignal({
        companyId: "co-1",
        reason: "the daily learning limit of 100c was reached",
        enforcement: "hard",
        activityAt: "2026-10-03T12:00:00.000Z",
      }),
    );
    expect(readForagingLimitSignal("co-1")).not.toBeNull();
    expect(readForagingLimitSignal("co-2")).toBeNull();
    clearForagingLimitSignal("co-1");
    expect(readForagingLimitSignal("co-1")).toBeNull();
  });

  it("builds the auto-off card with the threshold and the mean", () => {
    const signal = foragingAutoOffSignal({
      companyId: "co-1",
      meanCents: 40,
      thresholdCents: 25,
      activityAt: "2026-10-03T12:00:00.000Z",
    });
    expect(signal.whyNow).toContain("40c");
    expect(signal.whyNow).toContain("25c");
  });
});
