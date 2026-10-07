// myrmidon(UI-2.0 Wave A part 2, ia-v2 §3): live data hooks for the UI-2.0
// top bar chips. The dedicated GET /companies/:id/status-strip endpoint is
// still ahead (ia-v2 §6 G1) — until it lands the shell composes the same
// numbers from the aggregate endpoints already shipped, exactly as §3 pins:
//   colony  ← dashboard.agents (running / active+running+paused+error)
//   runs    ← live-runs.length + dashboard.runActivity[today].failed
//   spend   ← costs/summary (spendCents; budgetCents=0 → no "of $0")
//   waiting ← sidebar-badges.approvals + decisions(open) + interactions(pending)
// When STATUS-STRIP lands, only these hooks change; the chip model
// (ui2TopBarChips.ts) keeps its shape.
//
// Refetch policy (owner decision 03.10): chips refresh by interval and on
// refocus — no manual reload. 30 s matches the ia-v2 recommendation; the
// global refetchOnWindowFocus stays on (main.tsx default).
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { dashboardApi } from "@/api/dashboard";
import { sidebarBadgesApi } from "@/api/sidebarBadges";
import { costsApi } from "@/api/costs";
import { decisionsApi } from "@/api/decisions";
import { heartbeatsApi } from "@/api/heartbeats";
import { attentionApi } from "@/api/attention";
import {
  ui2ColonyChip,
  ui2RunsChip,
  ui2SpendChip,
  ui2WaitingBadge,
  ui2ApprovalsPendingFromBadges,
  ui2InteractionsPendingFromAttention,
  type Ui2ColonyChip,
  type Ui2RunsChip,
  type Ui2SpendChip,
  type Ui2WaitingBadge,
} from "./ui2TopBarChips";

export type { Ui2ColonyChip, Ui2RunsChip, Ui2SpendChip, Ui2WaitingBadge };

/** Chip polling cadence: one round-trip per 30 s (ia-v2 §3 recommendation). */
const UI2_CHIP_REFETCH_INTERVAL_MS = 30_000;

export interface Ui2StatusStrip {
  /** Colony: agents working vs total (dashboard.agents). */
  colony: Ui2ColonyChip | null;
  /** Runs: live runs + today's failed (live-runs + runActivity). */
  runs: Ui2RunsChip | null;
  /** Spend (costs/summary; budget part suppressed when 0). */
  spend: Ui2SpendChip | null;
  /** "Waiting for me" badge union; null when the badges source failed. */
  waiting: Ui2WaitingBadge | null;
}

/**
 * The live chip strip. Each chip degrades independently: a failed source
 * renders that chip's empty state, never a partial number (ia-v2 §3).
 */
export function useUi2StatusStrip(companyId: string | null | undefined): Ui2StatusStrip | null {
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard(companyId ?? ""),
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: companyId != null,
    refetchInterval: UI2_CHIP_REFETCH_INTERVAL_MS,
  });
  const badges = useQuery({
    queryKey: queryKeys.sidebarBadges(companyId ?? ""),
    queryFn: () => sidebarBadgesApi.get(companyId!),
    enabled: companyId != null,
    refetchInterval: UI2_CHIP_REFETCH_INTERVAL_MS,
  });
  const liveRuns = useQuery({
    queryKey: ["ui2", "chip", "live-runs", companyId ?? ""] as const,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: companyId != null,
    refetchInterval: UI2_CHIP_REFETCH_INTERVAL_MS,
  });
  const costs = useQuery({
    queryKey: ["ui2", "chip", "costs-summary", companyId ?? ""] as const,
    queryFn: () => costsApi.summary(companyId!),
    enabled: companyId != null,
    refetchInterval: UI2_CHIP_REFETCH_INTERVAL_MS,
  });
  const openDecisions = useQuery({
    queryKey: queryKeys.decisions.list(companyId ?? "", "open"),
    queryFn: () => decisionsApi.list(companyId!, { status: "open" }),
    enabled: companyId != null,
    refetchInterval: UI2_CHIP_REFETCH_INTERVAL_MS,
  });
  const attention = useQuery({
    queryKey: queryKeys.attention(companyId ?? ""),
    queryFn: () => attentionApi.list(companyId!, { limit: 1 }),
    enabled: companyId != null,
    refetchInterval: UI2_CHIP_REFETCH_INTERVAL_MS,
  });

  if (companyId == null) return null;

  return {
    colony: ui2ColonyChip(dashboard.data?.agents),
    runs: ui2RunsChip(
      liveRuns.data ? liveRuns.data.length : null,
      dashboard.data?.runActivity,
    ),
    spend: ui2SpendChip(costs.data),
    waiting: ui2WaitingBadge(
      ui2ApprovalsPendingFromBadges(badges.data),
      openDecisions.data,
      ui2InteractionsPendingFromAttention(attention.data),
    ),
  };
}

/** Just the decisions count, for the rail badge and phone tab badge. */
export function useUi2AttentionCount(): number | null {
  const { selectedCompanyId } = useCompany();
  const badges = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId ?? ""),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: selectedCompanyId != null,
    refetchInterval: UI2_CHIP_REFETCH_INTERVAL_MS,
  });
  return badges.data ? badges.data.approvals : null;
}
