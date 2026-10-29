// myrmidon(M2-B): the "Gateway keys" tab in the Costs & Budgets page.
// Shows per-agent gateway keys and flags fallback-loop misconfigurations.
// myrmidon(OPE-9859): Displays projected budgets/limits for agent and service keys.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, TriangleAlert } from "lucide-react";
import { i18n, useTranslation } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import {
  countKeyedAgents,
  isKeysNotEnabledError,
  litellmFallbacksKey,
  litellmKeyBudgetsKey,
  litellmKeysApi,
  litellmKeysKey,
  type AgentGatewayKeyView,
  type GatewayFallbackReport,
  type KeyBudgetLimitView,
} from "./litellmKeysApi";

/** One line per agent: the display name, the secret, and whether it is set. */
export interface GatewayKeyRow {
  agentId: string;
  agentName: string | null;
  role: string | null;
  secretName: string;
  present: boolean;
  budget: KeyBudgetLimitView | null;
}

/** Formats a budget ceiling limit for display in key rows. */
export function formatKeyBudget(
  budget: KeyBudgetLimitView | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!budget || budget.amountUsd === null || budget.amountUsd === undefined) {
    return t("area.costs-budgets-2.gateway-keys-tab.keysCard.noLimit");
  }
  const mode = budget.effectiveMode === "block" ? "block" : "soft";
  const period = budget.periodHours === 720 ? "/mo" : `/${budget.periodHours}h`;
  return t("area.costs-budgets-2.gateway-keys-tab.keysCard.limit", {
    amount: budget.amountUsd,
    period,
    mode,
  });
}

/** Joins the key views with the agent names the page already knows. */
export function keyRows(keys: AgentGatewayKeyView[], agentNames: Map<string, string>): GatewayKeyRow[] {
  return keys
    .map((entry) => ({
      agentId: entry.agentId,
      agentName: agentNames.get(entry.agentId) ?? entry.agentName ?? null,
      role: entry.role ?? null,
      secretName: entry.secretName,
      present: entry.present,
      budget: entry.budget ?? null,
    }))
    .sort((a, b) => (a.agentName ?? a.agentId).localeCompare(b.agentName ?? b.agentId));
}

/** The loops of a report, as display strings; an unreadable gateway yields none. */
export function cycleLines(report: GatewayFallbackReport | undefined): string[] {
  if (!report || report.error) return [];
  return report.cycles.map((cycle) => cycle.described);
}

function GatewayKeysCard({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useQuery({
    queryKey: litellmKeysKey(companyId),
    queryFn: () => litellmKeysApi.keys(companyId),
    staleTime: 60_000,
  });
  const { data: budgetData } = useQuery({
    queryKey: litellmKeyBudgetsKey(companyId),
    queryFn: () => litellmKeysApi.keyBudgets(companyId),
    staleTime: 60_000,
  });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents.data ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents.data]);
  const rows = useMemo(() => keyRows(data ?? [], names), [data, names]);
  const counts = countKeyedAgents(data ?? []);

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{t("area.costs-budgets-2.gateway-keys-tab.keysCard.title")}</CardTitle>
        <CardDescription>
          {t("area.costs-budgets-2.gateway-keys-tab.keysCard.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5 pt-2">
        {error ? (
          <p className="text-sm text-destructive">
            {isKeysNotEnabledError(error) ? t("area.costs-budgets-2.gateway-keys-tab.notEnabled") : (error as Error).message}
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">{t("area.costs-budgets-2.gateway-keys-tab.keysCard.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("area.costs-budgets-2.gateway-keys-tab.keysCard.empty")}</p>
        ) : (
          <>
            <div className="text-sm text-muted-foreground">
              {t("area.costs-budgets-2.gateway-keys-tab.keysCard.summary", { keyed: counts.keyed, total: counts.total })}
            </div>
            {rows.map((row) => (
              <div key={row.agentId} className="flex items-center gap-3 border border-border px-4 py-3">
                <span className="text-sm font-medium">{row.agentName ?? row.agentId.slice(0, 8)}</span>
                {row.role && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {row.role}
                  </span>
                )}
                <span className="truncate font-mono text-xs text-muted-foreground">{row.secretName}</span>
                <span className="ml-auto flex items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatKeyBudget(row.budget, t)}
                  </span>
                  <span className="text-xs tabular-nums">
                    {row.present ? t("area.costs-budgets-2.gateway-keys-tab.keysCard.keySet") : t("area.costs-budgets-2.gateway-keys-tab.keysCard.noKey")}
                  </span>
                </span>
              </div>
            ))}
            {budgetData && budgetData.services.length > 0 && (
              <div className="mt-4 space-y-2 border-t border-border pt-4">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t("area.costs-budgets-2.gateway-keys-tab.keysCard.servicesTitle")}
                </div>
                {budgetData.services.map((svc) => (
                  <div key={svc.serviceId} className="flex items-center gap-3 border border-border px-4 py-3">
                    <span className="text-sm font-medium">{svc.serviceName}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{svc.tag}</span>
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      {formatKeyBudget(svc.budget, t)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function GatewayFallbacksCard({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useQuery({
    queryKey: litellmFallbacksKey(companyId),
    queryFn: () => litellmKeysApi.fallbacks(companyId),
    staleTime: 60_000,
  });
  const lines = cycleLines(data);

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.title")}</CardTitle>
        <CardDescription>
          {t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5 pt-2">
        {error ? (
          <p className="text-sm text-destructive">
            {isKeysNotEnabledError(error) ? t("area.costs-budgets-2.gateway-keys-tab.notEnabled") : (error as Error).message}
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">{t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.loading")}</p>
        ) : data?.error ? (
          <p className="text-sm text-muted-foreground">{data.error}</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.empty")}</p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4" />
              {t("area.costs-budgets-2.gateway-keys-tab.fallbacksCard.found", { count: lines.length })}
            </div>
            {lines.map((line) => (
              <div key={line} className="border border-border px-4 py-2 font-mono text-xs">
                {line}
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The whole "Gateway keys" tab. */
export function GatewayKeysTab({ companyId }: { companyId: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-(--gtc-31)">
      <GatewayKeysCard companyId={companyId} />
      <GatewayFallbacksCard companyId={companyId} />
    </div>
  );
}

/** Standalone empty state for a page opened with no company selected. */
export function GatewayKeysNoCompany() {
  return <EmptyState icon={KeyRound} message={i18n.t("area.costs-budgets-2.gateway-keys-tab.noCompany")} />;
}
