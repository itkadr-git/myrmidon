// packages/shared/src/myrmidon-budget-config.myrmidon.test.ts
//
// myrmidon(1.7-BUDGET-CONFIG-READ): the pure projection behind
// GET …/budget-limits/config — the hierarchy tree (nest → caste →
// foraging → ticket) with hard/soft per configured row, the default
// substitution for a missing level, and the unavailable-level answer for an
// unresolvable ticket scope.

import { describe, expect, it } from "vitest";
import {
  BUDGET_CONFIG_DEFAULTS,
  BUDGET_CONFIG_LEVELS,
  BUDGET_CONFIG_LEVEL_TO_STORE_LEVEL,
  buildBudgetConfig,
  type BudgetLimitView,
} from "./myrmidon-budget-config.js";

const NOW = "2026-11-07T12:00:00.000Z";

function row(partial: Partial<BudgetLimitView> & { level: BudgetLimitView["level"]; ref: string }): BudgetLimitView {
  return {
    id: `limit-${partial.level}-${partial.ref}`,
    companyId: "company-a",
    amountCents: 10_000,
    period: "calendar_month_utc",
    mode: "hard",
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

const baseInput = {
  companyId: "company-a",
  signalOnly: true,
  signalOnlySource: "default" as const,
};

describe("myrmidon(1.7-BUDGET-CONFIG-READ) buildBudgetConfig", () => {
  it("maps every public level to an underlying store level", () => {
    expect(BUDGET_CONFIG_LEVELS).toEqual(["nest", "caste", "foraging", "ticket"]);
    expect(BUDGET_CONFIG_LEVEL_TO_STORE_LEVEL).toEqual({
      nest: "nest",
      caste: "caste",
      foraging: "foraging",
      ticket: "issue",
    });
  });

  it("returns the full tree with hard/soft per row when every level is configured", () => {
    const limits = [
      row({ level: "nest", ref: "company", mode: "hard" }),
      row({ level: "caste", ref: "engineer", mode: "soft" }),
      row({ level: "foraging", ref: "foraging", mode: "hard" }),
      row({ level: "issue", ref: "issue-1", mode: "soft" }),
    ];
    const config = buildBudgetConfig({ ...baseInput, limits, ticketIssueId: "issue-1" });
    expect(config.companyId).toBe("company-a");
    expect(config.signalOnly).toBe(true);
    expect(config.signalOnlySource).toBe("default");
    for (const level of BUDGET_CONFIG_LEVELS) {
      const node = config.levels[level];
      expect(node.level).toBe(level);
      expect(node.available).toBe(true);
      expect(node.configured).toBe(true);
      expect(node.isDefault).toBe(false);
      expect(node.limits).toHaveLength(1);
    }
    expect(config.levels.nest.limits[0].ref).toBe("company");
    expect(config.levels.nest.limits[0].mode).toBe("hard");
    expect(config.levels.caste.limits[0].ref).toBe("engineer");
    expect(config.levels.caste.limits[0].mode).toBe("soft");
    expect(config.levels.foraging.limits[0].ref).toBe("foraging");
    expect(config.levels.ticket.limits[0].ref).toBe("issue-1");
  });

  it("falls back to the default when a level has no configured row", () => {
    const limits = [row({ level: "nest", ref: "company", mode: "hard" })];
    const config = buildBudgetConfig({ ...baseInput, limits, ticketIssueId: null });
    expect(config.levels.nest.configured).toBe(true);
    for (const level of ["caste", "foraging", "ticket"] as const) {
      const node = config.levels[level];
      expect(node.available).toBe(true);
      expect(node.configured).toBe(false);
      expect(node.isDefault).toBe(true);
      expect(node.limits).toEqual([]);
      expect(node.defaults).toEqual({
        period: BUDGET_CONFIG_DEFAULTS.period,
        mode: BUDGET_CONFIG_DEFAULTS.mode,
      });
    }
  });

  it("reports the ticket level unavailable when the scope does not resolve", () => {
    const limits = [row({ level: "issue", ref: "issue-1" })];
    const config = buildBudgetConfig({
      ...baseInput,
      limits,
      ticketIssueId: "issue-unknown",
      ticketAvailable: false,
    });
    expect(config.levels.ticket.available).toBe(false);
    expect(config.levels.ticket.configured).toBe(false);
    expect(config.levels.ticket.isDefault).toBe(true);
    expect(config.levels.ticket.limits).toEqual([]);
    // Other levels stay readable.
    expect(config.levels.nest.available).toBe(true);
    expect(config.levels.caste.available).toBe(true);
    expect(config.levels.foraging.available).toBe(true);
  });

  it("lists every configured caste row sorted by ref", () => {
    const limits = [
      row({ level: "caste", ref: "reviewer" }),
      row({ level: "caste", ref: "engineer" }),
    ];
    const config = buildBudgetConfig({ ...baseInput, limits, ticketIssueId: null });
    expect(config.levels.caste.limits.map((e) => e.ref)).toEqual(["engineer", "reviewer"]);
  });
});
