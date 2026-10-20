import { useQuery } from "@tanstack/react-query";
import type { AgentListItem } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2Page, Ui2StatusDot } from "../../components/ui2Primitives";
import { Ui2EmptyStateView, Ui2ErrorState, Ui2SkeletonRows } from "../../components/ui2StateViews";

export type FleetStatus = "idle" | "running" | "error" | "paused";

export function fleetStatus(status: string, run?: LiveRunForIssue): FleetStatus {
  if (status === "error" || status === "terminated" || run?.status === "failed") return "error";
  if (status === "paused") return "paused";
  if (status === "running") return "running";
  return "idle";
}

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
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: 50, limit: 100 }),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 15_000,
  });
  const latestRuns = new Map<string, LiveRunForIssue>();
  for (const run of runsQuery.data ?? []) {
    const current = latestRuns.get(run.agentId);
    if (!current || new Date(run.createdAt).getTime() > new Date(current.createdAt).getTime()) {
      latestRuns.set(run.agentId, run);
    }
  }
  const agentsById = new Map<string, AgentListItem>(agents.map((agent) => [agent.id, agent]));
  const childrenByManager = new Map<string, AgentListItem[]>();
  const roots: AgentListItem[] = [];
  const parentByAgent = new Map<string, string>();
  for (const agent of agents) {
    if (agent.reportsTo && agentsById.has(agent.reportsTo)) {
      const children = childrenByManager.get(agent.reportsTo) ?? [];
      children.push(agent);
      childrenByManager.set(agent.reportsTo, children);
      parentByAgent.set(agent.id, agent.reportsTo);
    } else {
      roots.push(agent);
    }
  }
  // Cyclic reporting chains have no natural root; render one member as a root
  // and let the visited set prevent recursion while preserving every agent.
  for (const agent of agents) {
    let cursor = agent.id;
    const seen = new Set<string>();
    while (parentByAgent.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentByAgent.get(cursor)!;
    }
    if (seen.has(cursor)) {
      for (const cycleId of seen) {
        const cycleRoot = agentsById.get(cycleId);
        if (cycleRoot && !roots.some((root) => root.id === cycleId)) roots.push(cycleRoot);
      }
    }
  }
  const renderAgent = (agent: AgentListItem, ancestors = new Set<string>()) => {
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(agent.id);
    const run = latestRuns.get(agent.id);
    const state = fleetStatus(String(agent.status), run);
    const tone = state === "error" ? "danger" : state === "running" ? "ok" : "muted";
    return <li key={agent.id}>
      <Link to={`/agents/${agent.id}`} className="flex min-h-16 flex-wrap items-center gap-x-5 gap-y-2 p-4 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-40 flex-1 font-medium">{agent.name}</span>
        <span className="text-sm text-muted-foreground">{t("ui2.agents.role" as never)}: {agent.role}</span>
        <span className="flex items-center gap-2 text-sm"><Ui2StatusDot tone={tone} />{t(`ui2.agents.status.${state}` as never)}</span>
        <span className="text-sm text-muted-foreground">{t("ui2.agents.run" as never)}: {run?.id ?? t("ui2.common.unknown" as never)}</span>
      </Link>
      {(childrenByManager.get(agent.id) ?? []).some((child) => !nextAncestors.has(child.id)) ? <ul className="ml-5 border-l border-border">{(childrenByManager.get(agent.id) ?? []).filter((child) => !nextAncestors.has(child.id)).map((child) => renderAgent(child, nextAncestors))}</ul> : null}
    </li>;
  };
  return (
    <Ui2Page title={t("ui2.agents.title" as never)}>
      {agentsQuery.isLoading ? <Ui2SkeletonRows rows={6} /> : null}
      {agentsQuery.isError ? <Ui2ErrorState message={t("ui2.common.error" as never)} retryLabel={t("ui2.common.retry" as never)} onRetry={() => void agentsQuery.refetch()} /> : null}
      {agentsQuery.isSuccess && agents.length === 0 ? <Ui2EmptyStateView title={t("ui2.agents.empty" as never)} variant="done" /> : null}
      {agents.length > 0 ? (
        <section aria-label={t("ui2.agents.title" as never)} className="max-h-[70vh] overflow-y-auto overscroll-contain rounded-lg border border-border bg-card">
          <ul className="divide-y divide-border">
            {roots.map((agent: AgentListItem) => renderAgent(agent))}
          </ul>
        </section>
      ) : null}
    </Ui2Page>
  );
}
