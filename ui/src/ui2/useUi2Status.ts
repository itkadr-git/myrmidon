// The status-strip endpoint is the single source for UI-2.0 header chips.
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { statusStripApi } from "@/api/statusStrip";

export interface Ui2StatusStrip {
  /** Colony: agents working vs total. */
  colonyActive: number;
  colonyTotal: number;
  /** Fleet attention flag: error agents or failed runs need a look. */
  fleetAttention: boolean;
  /** Month spend cents + budget cents (forecast chip). */
  monthSpendCents: number;
  monthBudgetCents: number;
  /** Decisions waiting for the owner. */
  attentionCount: number;
}

export function useUi2StatusStrip(companyId: string | null | undefined): Ui2StatusStrip | null {
  const statusStrip = useQuery({
    queryKey: queryKeys.statusStrip(companyId ?? ""),
    queryFn: () => statusStripApi.get(companyId!),
    enabled: companyId != null,
  });

  if (companyId == null || !statusStrip.data) return null;

  const strip = statusStrip.data;
  const colonyActive = strip.colony.running;
  const colonyTotal = strip.colony.running + strip.colony.idle + strip.colony.paused + strip.colony.error;

  return {
    colonyActive,
    colonyTotal,
    fleetAttention: strip.colony.error > 0 || strip.runs.failedToday > 0,
    monthSpendCents: strip.costs.monthSpendCents,
    monthBudgetCents: strip.costs.budgetCents,
    attentionCount: strip.waiting.approvals,
  };
}

/** Just the decisions count, for the rail badge and phone tab badge. */
export function useUi2AttentionCount(): number | null {
  const { selectedCompanyId } = useCompany();
  const statusStrip = useQuery({
    queryKey: queryKeys.statusStrip(selectedCompanyId ?? ""),
    queryFn: () => statusStripApi.get(selectedCompanyId!),
    enabled: selectedCompanyId != null,
  });
  return statusStrip.data ? statusStrip.data.waiting.approvals : null;
}
