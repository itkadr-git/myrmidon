// myrmidon(UI2, ia-v2 §3): the pure model behind the UI-2.0 top bar chips.
// Every value the chips render is derived HERE from the exact API responses
// the shell already consumes, so the mapping is testable without a server
// (fixtures: empty / error / data) and the "no partial numbers" rule of
// ia-v2 §3 is enforced in one place: a chip either has a complete source or
// it renders nothing (null), never a half-invented number.
//
// Chip sources (owner decision 03.10, ia-v2 §3):
//   Colony  "N of M"   running / (active + running + paused + error)
//                     from dashboard.agents (GET /companies/:id/dashboard).
//   Runs    "N · F failed today" (F > 0 renders the failure part)
//                     N = live-runs.length (GET /companies/:id/live-runs,
//                     statuses queued+running), F = runActivity[today].failed
//                     from dashboard.runActivity (UTC date key).
//   Spend   "$X of $Y" or "$X" when budgetCents = 0 — no "of $0" text —
//                     from costs/summary (GET /companies/:id/costs/summary).
//   Waiting badge approvals(pending) + decisions(open) + interactions(pending).
//                     Until the unified decision-inbox API lands (ia-v2 G4),
//                     the owner-facing union is composed on the client from
//                     sidebar-badges.approvals, decisions?status=open and
//                     attention countsBySourceKind.issue_thread_interaction.
//
// The hooks in useUi2Status.ts wire these pure functions to react-query.

import type { DashboardSummary } from "@paperclipai/shared";
import type { CostSummary } from "@paperclipai/shared";
import type { SidebarBadges } from "@paperclipai/shared";
import type { Decision } from "@/api/decisions";
import type { AttentionFeed } from "@paperclipai/shared";

/** Colony chip: null until the dashboard summary arrives. */
export interface Ui2ColonyChip {
  /** agents currently running (dashboard.agents.running). */
  running: number;
  /** M = active + running + paused + error (terminated excluded by the API). */
  total: number;
  /** Attention tone when any agent is in the error state (ia-v2 §3). */
  attention: boolean;
}

export function ui2ColonyChip(agents: DashboardSummary["agents"] | undefined): Ui2ColonyChip | null {
  if (!agents) return null;
  return {
    running: agents.running,
    total: agents.active + agents.running + agents.paused + agents.error,
    attention: agents.error > 0,
  };
}

/** Runs chip: live runs + today's true failures. */
export interface Ui2RunsChip {
  /** live-runs.length (queued + running). */
  running: number;
  /** runActivity[today].failed — true failures, recovered runs excluded by the API. */
  failedToday: number;
  /** Attention tone when failedToday > 0 (ia-v2 §3). */
  attention: boolean;
}

/** Today's UTC date key `YYYY-MM-DD` — the key format of runActivity rows. */
export function ui2TodayUtcKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function ui2RunsChip(
  liveRunCount: number | null | undefined,
  runActivity: DashboardSummary["runActivity"] | undefined,
  now: Date = new Date(),
): Ui2RunsChip | null {
  if (liveRunCount == null || !runActivity) return null;
  const todayKey = ui2TodayUtcKey(now);
  // Exact today match only: a stale feed without today's key must not show
  // yesterday's failures as "failed today".
  const today = runActivity.find((day: DashboardSummary["runActivity"][number]) => day.date === todayKey);
  const failedToday = today?.failed ?? 0;
  return {
    running: liveRunCount,
    failedToday,
    attention: failedToday > 0,
  };
}

/** Spend chip: no budget → no "of $0" (owner decision, ia-v2 §3). */
export interface Ui2SpendChip {
  /** costs/summary.spendCents formatted as $ money. */
  spend: string;
  /** Raw spend cents for tests. */
  spendCents: number;
  /** Raw budget cents; 0 means "no budget set" and suppresses the budget part. */
  budgetCents: number;
  /** Budget part "of $Y" — null when budgetCents = 0. */
  budget: string | null;
}

export function ui2FormatMoneyCents(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export function ui2SpendChip(summary: CostSummary | undefined): Ui2SpendChip | null {
  if (!summary) return null;
  const budget = summary.budgetCents > 0 ? ui2FormatMoneyCents(summary.budgetCents) : null;
  return {
    spend: ui2FormatMoneyCents(summary.spendCents),
    spendCents: summary.spendCents,
    budgetCents: summary.budgetCents,
    budget,
  };
}

/** "Ждёт меня" badge: owner-facing union of the three sources (ia-v2 §3, G4). */
export interface Ui2WaitingBadge {
  count: number;
  approvals: number;
  decisions: number;
  interactions: number;
}

export function ui2WaitingBadge(
  approvalsPending: number | null | undefined,
  openDecisions: Array<Pick<Decision, "status">> | null | undefined,
  interactionsPending: number | null | undefined,
): Ui2WaitingBadge | null {
  if (approvalsPending == null) return null;
  const decisions = openDecisions ? openDecisions.filter((entry) => entry.status === "open").length : null;
  // A failed decisions/attention source degrades to approvals-only: the badge
  // shows the part it knows (ia-v2 §2.2.1 "ошибка одного источника — остальные
  // показываются"), never a wrong total.
  const count =
    approvalsPending + (decisions ?? 0) + (interactionsPending ?? 0);
  return {
    count,
    approvals: approvalsPending,
    decisions: decisions ?? 0,
    interactions: interactionsPending ?? 0,
  };
}

/** Pending issue-thread interactions from the attention feed counts. */
export function ui2InteractionsPendingFromAttention(feed: AttentionFeed | undefined): number | null {
  if (!feed) return null;
  const counts = feed.countsBySourceKind as Partial<Record<string, number>>;
  return counts.issue_thread_interaction ?? 0;
}

/** Pending approvals from sidebar badges (the shipped owner-facing counter). */
export function ui2ApprovalsPendingFromBadges(badges: SidebarBadges | undefined): number | null {
  return badges ? badges.approvals : null;
}
