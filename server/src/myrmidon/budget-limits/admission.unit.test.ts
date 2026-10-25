// server/src/myrmidon/budget-limits/admission.unit.test.ts
//
// myrmidon(1.7-BUDGET-CONFIG): the admission decision core — which limits
// refuse a run start. Pure data-in/data-out: the effective limit (already
// precedence-resolved by the store resolver) plus the spend of the period
// against the global signal-only flag. Pinning the ticket criteria:
//  - a limit change acts on the next admission without a restart (the
//    decision reads what it is handed — the db-backed evaluator resolves
//    fresh on every admission, pinned separately against the real database);
//  - signal-only never refuses;
//  - only a hard, active, over-its-period limit refuses;
//  - the deepest level wins (the resolver's job — pinned as the integration
//    contract through the effective view this function consumes).

import { describe, expect, it } from "vitest";
import type { EffectiveBudgetLimitView } from "@myrmidon/shared";
import { decideBudgetLimitAdmission } from "./admission.js";

function effective(overrides: Partial<EffectiveBudgetLimitView> = {}): EffectiveBudgetLimitView {
  return {
    amountCents: 500,
    period: "calendar_month_utc",
    mode: "hard",
    sourceLevel: "issue",
    sourceRef: "issue-1",
    sourceLimitId: "limit-1",
    ...overrides,
  };
}

describe("budget-limit admission decision (1.7 BUDGET-CONFIG)", () => {
  it("a hard, active, over-its-period limit refuses with the level in the reason", () => {
    const decision = decideBudgetLimitAdmission(effective(), 600, { signalOnly: false });
    expect(decision.blocked).toBe(true);
    if (!decision.blocked) return;
    expect(decision.scopeType).toBe("issue");
    expect(decision.scopeId).toBe("issue-1");
    expect(decision.reason).toContain("$6.00");
    expect(decision.reason).toContain("$5.00");
    expect(decision.sourceLevel).toBe("issue");
  });

  it("at exactly the limit the run still starts (over means over, not equal)", () => {
    expect(decideBudgetLimitAdmission(effective(), 500, { signalOnly: false })).toEqual({ blocked: false });
  });

  it("signal-only never refuses — the overrun is report-only", () => {
    expect(decideBudgetLimitAdmission(effective(), 9_999_99, { signalOnly: true })).toEqual({ blocked: false });
  });

  it("a soft limit never refuses on admission (the B pause machinery handles soft)", () => {
    expect(
      decideBudgetLimitAdmission(effective({ mode: "soft" }), 9_999, { signalOnly: false }),
    ).toEqual({ blocked: false });
  });

  it("no limit → no block", () => {
    expect(
      decideBudgetLimitAdmission(
        { amountCents: null, period: null, mode: null, sourceLevel: null, sourceRef: null, sourceLimitId: null },
        9_999,
        { signalOnly: false },
      ),
    ).toEqual({ blocked: false });
  });

  it("each level maps to its reported scope (vendor names; the ref rides in scopeRef)", () => {
    const agentId = "agent-1";
    const cases: Array<[NonNullable<EffectiveBudgetLimitView["sourceLevel"]>, string, string, string]> = [
      ["issue", "issue-1", "agent", agentId],
      ["foraging", "foraging", "agent", agentId],
      ["caste", "engineer", "agent", agentId],
      ["nest", "company", "company", "company"],
      ["nest", "project-1", "project", "project-1"],
    ];
    for (const [level, ref, scopeType, scopeId] of cases) {
      const decision = decideBudgetLimitAdmission(
        effective({ sourceLevel: level, sourceRef: ref }),
        600,
        { signalOnly: false, agentId },
      );
      expect(decision.blocked, `${level}/${ref}`).toBe(true);
      if (!decision.blocked) continue;
      expect(decision.scopeType, `${level}/${ref}`).toBe(scopeType);
      expect(decision.scopeId, `${level}/${ref}`).toBe(scopeId);
      expect(decision.sourceLevel, `${level}/${ref}`).toBe(level);
    }
  });

  it("lifetime says so in the reason; calendar month says calendar month", () => {
    const lifetime = decideBudgetLimitAdmission(effective({ period: "lifetime" }), 600, { signalOnly: false });
    if (!lifetime.blocked) throw new Error("expected blocked");
    expect(lifetime.reason).toContain("lifetime");
    const month = decideBudgetLimitAdmission(effective(), 600, { signalOnly: false });
    if (!month.blocked) throw new Error("expected blocked");
    expect(month.reason).toContain("calendar month");
  });
});
