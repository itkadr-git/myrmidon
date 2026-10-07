// ui/src/ui2/tests/ui2TopBarChips.myrmidon.test.ts
//
// myrmidon(UI-2.0 Wave A part 2, ia-v2 §3 + §7.5): guard tests for the top
// bar chip model. Every chip number must come from its pinned API field —
// the fixtures cover the three states each source can be in:
//   empty  (source not resolved yet — chip renders its empty state),
//   error  (query failed — same empty state, never a partial number),
//   data   (the mapping itself, exact field arithmetic).
// Plus the owner rules:
//   - budgetCents = 0 → NO "of $0" text (spendNoBudget);
//   - the waiting badge is the union approvals(pending) + decisions(open) +
//     interactions(pending), and degrades to approvals-only when a source
//     failed;
//   - the Fleet chip is gone (no fleet keys used anywhere in the top bar).

import { describe, expect, it } from "vitest";
import type { DashboardSummary, SidebarBadges, AttentionFeed, CostSummary } from "@paperclipai/shared";
import type { Decision } from "@/api/decisions";
import {
  ui2ColonyChip,
  ui2RunsChip,
  ui2SpendChip,
  ui2FormatMoneyCents,
  ui2WaitingBadge,
  ui2InteractionsPendingFromAttention,
  ui2ApprovalsPendingFromBadges,
  ui2TodayUtcKey,
} from "../ui2TopBarChips";

/* ---------------------------------------------------------------- fixtures */

const NOW = new Date("2026-10-03T12:00:00.000Z");

function dashboardFixture(overrides: Partial<DashboardSummary["agents"]> = {}): DashboardSummary {
  return {
    companyId: "company-1",
    agents: { active: 61, running: 18, paused: 2, error: 1, ...overrides },
    tasks: { open: 118, inProgress: 42, blocked: 118, done: 950 },
    costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
    pendingApprovals: 1,
    budgets: { activeIncidents: 0, pendingApprovals: 1, pausedAgents: 0, pausedProjects: 0 },
    runActivity: [
      { date: "2026-10-02", succeeded: 500, failed: 40, recovered: 2, other: 10, total: 552, failedByErrorCode: {} },
      { date: ui2TodayUtcKey(NOW), succeeded: 609, failed: 56, recovered: 3, other: 21, total: 689, failedByErrorCode: {} },
    ],
  };
}

function costSummaryFixture(overrides: Partial<CostSummary> = {}): CostSummary {
  return { companyId: "company-1", spendCents: 31_454, budgetCents: 0, utilizationPercent: 0, ...overrides };
}

function decisionFixture(status: Decision["status"]): Pick<Decision, "status"> {
  return { status };
}

function attentionFixture(interactions: number): AttentionFeed {
  const countsBySourceKind = {
    approval: 0,
    decision: 0,
    issue_thread_interaction: interactions,
    join_request: 0,
    recovery_action: 0,
    productivity_review: 0,
    blocker_attention: 0,
    review: 0,
    failed_run: 0,
    budget_alert: 0,
    agent_error_alert: 0,
    stack_update: 0,
    stale_block: 0,
  } as AttentionFeed["countsBySourceKind"];
  return {
    companyId: "company-1",
    generatedAt: "2026-10-03T12:00:00.000Z",
    totalCount: interactions,
    deskBadgeCount: interactions,
    nextCursor: null,
    countsBySourceKind,
    items: [],
  };
}

/* ------------------------------------------------------------------ colony */

describe("myrmidon(UI2) colony chip mapping", () => {
  it("maps N of M from dashboard.agents: running / active+running+paused+error", () => {
    // 18 running of 61+18+2+1 = 82 total (ia-v2 fact table).
    const chip = ui2ColonyChip(dashboardFixture().agents);
    expect(chip).toEqual({ running: 18, total: 82, attention: true });
  });

  it("counts running inside M (total includes running, not just active)", () => {
    const chip = ui2ColonyChip({ active: 0, running: 5, paused: 0, error: 0 });
    expect(chip?.total).toBe(5);
    expect(chip?.running).toBe(5);
  });

  it("renders empty (null) while the dashboard source is empty or failed", () => {
    expect(ui2ColonyChip(undefined)).toBeNull();
  });

  it("attention tone only when error > 0", () => {
    expect(ui2ColonyChip({ active: 10, running: 1, paused: 0, error: 0 })?.attention).toBe(false);
    expect(ui2ColonyChip({ active: 10, running: 1, paused: 0, error: 2 })?.attention).toBe(true);
  });
});

/* -------------------------------------------------------------------- runs */

describe("myrmidon(UI2) runs chip mapping", () => {
  it("maps live-runs.length + runActivity[today].failed", () => {
    const chip = ui2RunsChip(21, dashboardFixture().runActivity, NOW);
    expect(chip).toEqual({ running: 21, failedToday: 56, attention: true });
  });

  it("uses the last runActivity row when today's key is absent (timezone boundary)", () => {
    const runActivity = [{ date: "2026-10-01", succeeded: 1, failed: 7, recovered: 0, other: 0, total: 8, failedByErrorCode: {} }];
    // No today row → failed today reads as 0, never yesterday's failures.
    const chip = ui2RunsChip(3, runActivity, NOW);
    expect(chip?.failedToday).toBe(0);
  });

  it("renders empty (null) while live-runs has not resolved", () => {
    expect(ui2RunsChip(null, dashboardFixture().runActivity, NOW)).toBeNull();
    expect(ui2RunsChip(21, undefined, NOW)).toBeNull();
  });

  it("attention tone only when failed today > 0", () => {
    const clean = dashboardFixture();
    clean.runActivity = clean.runActivity.map((day: { date: string; succeeded: number; failed: number; recovered: number; other: number; total: number; failedByErrorCode: Record<string, number> }) => ({ ...day, failed: 0 }));
    expect(ui2RunsChip(21, clean.runActivity, NOW)?.attention).toBe(false);
  });
});

/* ------------------------------------------------------------------- spend */

describe("myrmidon(UI2) spend chip mapping", () => {
  it("maps costs/summary.spendCents and formats as $ money", () => {
    const chip = ui2SpendChip(costSummaryFixture({ spendCents: 31_454 }));
    expect(chip?.spend).toBe("$315");
    expect(chip?.spendCents).toBe(31_454);
  });

  it("renders NO 'of $0' text when budgetCents = 0 (owner rule)", () => {
    const chip = ui2SpendChip(costSummaryFixture({ budgetCents: 0 }));
    expect(chip?.budget).toBeNull();
  });

  it("renders the budget part when a budget is set", () => {
    const chip = ui2SpendChip(costSummaryFixture({ budgetCents: 220_000 }));
    expect(chip?.budget).toBe("$2,200");
  });

  it("renders empty (null) while costs/summary has not resolved", () => {
    expect(ui2SpendChip(undefined)).toBeNull();
  });

  it("rounds and groups cents into dollars (mono chip contract)", () => {
    expect(ui2FormatMoneyCents(0)).toBe("$0");
    expect(ui2FormatMoneyCents(99)).toBe("$1");
    expect(ui2FormatMoneyCents(157_400)).toBe("$1,574");
  });
});

/* ----------------------------------------------------------------- waiting */

describe("myrmidon(UI2) waiting badge union", () => {
  it("sums approvals(pending) + decisions(open) + interactions(pending)", () => {
    const badge = ui2WaitingBadge(
      1,
      [decisionFixture("open"), decisionFixture("open"), decisionFixture("decided")],
      4,
    );
    expect(badge).toEqual({ count: 7, approvals: 1, decisions: 2, interactions: 4 });
  });

  it("counts only open decisions", () => {
    const badge = ui2WaitingBadge(0, [decisionFixture("expired"), decisionFixture("cancelled")], 0);
    expect(badge?.count).toBe(0);
  });

  it("degrades to approvals-only when a union source failed (null)", () => {
    const badge = ui2WaitingBadge(3, null, null);
    expect(badge).toEqual({ count: 3, approvals: 3, decisions: 0, interactions: 0 });
  });

  it("renders empty (null) when the approvals source failed (badges = null)", () => {
    expect(ui2WaitingBadge(null, [decisionFixture("open")], 2)).toBeNull();
  });

  it("reads interactions from attention countsBySourceKind", () => {
    expect(ui2InteractionsPendingFromAttention(attentionFixture(7))).toBe(7);
    expect(ui2InteractionsPendingFromAttention(undefined)).toBeNull();
    expect(ui2InteractionsPendingFromAttention(attentionFixture(0))).toBe(0);
  });

  it("reads approvals from sidebar badges", () => {
    const badges: SidebarBadges = { inbox: 0, approvals: 5, failedRuns: 1, joinRequests: 0 };
    expect(ui2ApprovalsPendingFromBadges(badges)).toBe(5);
    expect(ui2ApprovalsPendingFromBadges(undefined)).toBeNull();
  });
});

/* ------------------------------------------------------------ date key rule */

describe("myrmidon(UI2) today key", () => {
  it("is the UTC date key matching runActivity rows", () => {
    expect(ui2TodayUtcKey(NOW)).toBe("2026-10-03");
  });
});
