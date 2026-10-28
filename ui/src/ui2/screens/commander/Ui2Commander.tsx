// myrmidon(UI2-2.0): Command Center live dashboard.
// ia-v2 §4 sources: dashboard summary (fleet), heartbeat live-runs (active
// runs), approvals/decisions and the attention feed (interactions included).
// The attention feed is the canonical "waiting for me" aggregation, so its
// count is shared with the shell badge rather than recomputed client-side.
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { dashboardApi } from "@/api/dashboard";
import { heartbeatsApi } from "@/api/heartbeats";
import { approvalsApi } from "@/api/approvals";
import { decisionsApi } from "@/api/decisions";
import { attentionApi } from "@/api/attention";
import { queryKeys } from "@/lib/queryKeys";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2Page, Ui2Section, Ui2Tile, Ui2EmptyState } from "../../components/ui2Primitives";
import { Ui2ErrorState, Ui2SkeletonRows } from "../../components/ui2StateViews";

export function Ui2Commander() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";

  // ia-v2 §4: dashboard is the source for fleet totals and health signals.
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard(companyId),
    queryFn: () => dashboardApi.summary(companyId),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 30_000,
  });
  // ia-v2 §4: heartbeat live-runs is the source for active execution rows.
  const liveRuns = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { limit: 25 }),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 15_000,
  });
  // ia-v2 §4: direct lists provide their own counts; the attention feed adds
  // pending thread interactions and its deskBadgeCount matches the shell chip.
  const [approvals, decisions, attention] = useQueries({
    queries: [
      {
        queryKey: queryKeys.approvals.list(companyId, "pending"),
        queryFn: () => approvalsApi.list(companyId, "pending"),
        enabled: Boolean(selectedCompanyId),
        refetchInterval: 30_000,
      },
      {
        queryKey: queryKeys.decisions.list(companyId, "open"),
        queryFn: () => decisionsApi.list(companyId, { status: "open" }),
        enabled: Boolean(selectedCompanyId),
        refetchInterval: 30_000,
      },
      {
        queryKey: queryKeys.attention(companyId),
        queryFn: () => attentionApi.list(companyId, { limit: 100 }),
        enabled: Boolean(selectedCompanyId),
        refetchInterval: 30_000,
      },
    ],
  });

  const loading = dashboard.isLoading || liveRuns.isLoading || approvals.isLoading || decisions.isLoading || attention.isLoading;
  const error = dashboard.error ?? liveRuns.error ?? approvals.error ?? decisions.error ?? attention.error;
  if (loading) return <Ui2Page title={t("ui2.commander.title")}><Ui2SkeletonRows rows={5} /></Ui2Page>;
  if (error) {
    return <Ui2Page title={t("ui2.commander.title")}><Ui2ErrorState message={t("ui2.common.error")} detail={String(error)} /></Ui2Page>;
  }

  const summary = dashboard.data;
  const runs = liveRuns.data ?? [];
  const pendingApprovals = approvals.data ?? [];
  const openDecisions = decisions.data ?? [];
  const feed = attention.data;
  const interactionCount = feed?.countsBySourceKind?.issue_thread_interaction ?? 0;
  const attentionCount = feed?.deskBadgeCount ?? pendingApprovals.length + openDecisions.length + interactionCount;

  return (
    <Ui2Page title={t("ui2.commander.title")} subtitle={t("ui2.commander.subtitle")}>
      <Ui2Section title={t("ui2.commander.attention.title")}>
        <Ui2TilesRow>
          <Ui2Tile label={t("ui2.commander.attention.total")} value={String(attentionCount)} tone={attentionCount ? "warning" : "ok"} />
          <Ui2Tile label={t("ui2.commander.attention.approvals")} value={String(pendingApprovals.length)} />
          <Ui2Tile label={t("ui2.commander.attention.decisions")} value={String(openDecisions.length)} />
          <Ui2Tile label={t("ui2.commander.attention.interactions")} value={String(interactionCount)} />
        </Ui2TilesRow>
        {attentionCount === 0 ? <Ui2EmptyState title={t("ui2.commander.empty.attention")} /> : null}
      </Ui2Section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Ui2Section title={t("ui2.commander.runs.title")}>
          {runs.length === 0 ? <Ui2EmptyState title={t("ui2.commander.empty.runs")} /> : (
            <div className="flex flex-col gap-2">
              {runs.map((run) => (
                <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
                  <span className="font-medium">{run.agentName}</span>
                  <span className="text-muted-foreground">{run.currentStatusMessage ?? run.status}</span>
                </div>
              ))}
            </div>
          )}
        </Ui2Section>
        {/* ia-v2 §4: Fleet attention widget maps aggregated agent fleet states from DashboardSummary (active, running, paused, error).
            Supplemented with health status indicator and direct navigation to /agents. */}
        <Ui2Section
          title={t("ui2.commander.fleet.title")}
          footer={
            summary ? (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {summary.agents.error > 0
                    ? t("ui2.commander.fleet.statusErrors", { count: summary.agents.error })
                    : summary.agents.paused > 0
                      ? t("ui2.commander.fleet.statusPaused", { count: summary.agents.paused })
                      : t("ui2.commander.fleet.statusHealthy")}
                </span>
                <Link to="/agents" className="text-primary hover:underline">
                  {t("ui2.commander.fleet.viewFleet")}
                </Link>
              </div>
            ) : undefined
          }
        >
          {summary ? (
            <Ui2TilesRow>
              <Ui2Tile label={t("ui2.commander.fleet.active")} value={String(summary.agents.active)} />
              <Ui2Tile label={t("ui2.commander.fleet.running")} value={String(summary.agents.running)} tone="ok" />
              <Ui2Tile label={t("ui2.commander.fleet.paused")} value={String(summary.agents.paused)} />
              <Ui2Tile label={t("ui2.commander.fleet.errors")} value={String(summary.agents.error)} tone={summary.agents.error ? "danger" : "ok"} />
            </Ui2TilesRow>
          ) : (
            <Ui2EmptyState title={t("ui2.commander.empty.fleet")} />
          )}
        </Ui2Section>
      </div>
    </Ui2Page>
  );
}

function Ui2TilesRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>;
}
