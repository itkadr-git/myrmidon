import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2Page, Ui2StatusDot } from "../../components/ui2Primitives";
import { Ui2EmptyStateView, Ui2ErrorState, Ui2SkeletonRows } from "../../components/ui2StateViews";

export function Ui2AgentsFleetPage() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 30_000,
  });
  const agents = agentsQuery.data ?? [];
  const runsQuery = useQuery({
    queryKey: queryKeys.heartbeats(companyId),
    queryFn: () => heartbeatsApi.list(companyId),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 15_000,
  });
  const latestRuns = new Map<string, { id: string; status: string; createdAt: string | Date }>();
  for (const run of runsQuery.data ?? []) {
    const current = latestRuns.get(run.agentId);
    if (!current || new Date(run.createdAt).getTime() > new Date(current.createdAt).getTime()) {
      latestRuns.set(run.agentId, { id: run.id, status: run.status, createdAt: run.createdAt });
    }
  }
  return (
    <Ui2Page title={t("ui2.agents.title" as never)}>
      {agentsQuery.isLoading ? <Ui2SkeletonRows rows={6} /> : null}
      {agentsQuery.isError ? <Ui2ErrorState message={t("ui2.common.error" as never)} retryLabel={t("ui2.common.retry" as never)} onRetry={() => void agentsQuery.refetch()} /> : null}
      {agentsQuery.isSuccess && agents.length === 0 ? <Ui2EmptyStateView title={t("ui2.agents.empty" as never)} variant="done" /> : null}
      {agents.length > 0 ? (
        <section aria-label={t("ui2.agents.title" as never)} className="max-h-[70vh] overflow-y-auto overscroll-contain rounded-lg border border-border bg-card">
          <ul className="divide-y divide-border">
            {agents.map((agent) => {
              const run = latestRuns.get(agent.id);
              const state = agent.status === "error" ? "error" : run?.status === "running" || agent.status === "running" || agent.status === "active" ? "running" : "idle";
              return <li key={agent.id}>
                <Link to={`/agents/${agent.id}`} className="flex min-h-16 flex-wrap items-center gap-x-5 gap-y-2 p-4 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="min-w-40 flex-1 font-medium">{agent.name}</span>
                  <span className="text-sm text-muted-foreground">{t("ui2.agents.role" as never)}: {agent.role}</span>
                  <span className="flex items-center gap-2 text-sm"><Ui2StatusDot tone={state === "error" ? "danger" : state === "running" ? "ok" : "default"} />{t(`ui2.agents.status.${state}` as never)}</span>
                  <span className="text-sm text-muted-foreground">{t("ui2.agents.run" as never)}: {run?.id ?? t("ui2.common.unknown" as never)}</span>
                </Link>
              </li>;
            })}
          </ul>
        </section>
      ) : null}
    </Ui2Page>
  );
}
