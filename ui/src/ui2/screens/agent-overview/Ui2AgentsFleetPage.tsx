import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AgentListFilters, AgentListItem } from "@myrmidon/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { pollInterval } from "@/lib/auth-session-recovery";
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

// Debounce the live input value so typing does not fire a request per keystroke.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const FLEET_STATUSES: Array<{ value: string; labelKey: string }> = [
  { value: "", labelKey: "ui2.agents.filter.status.all" },
  { value: "active", labelKey: "ui2.agents.filter.status.active" },
  { value: "paused", labelKey: "ui2.agents.filter.status.paused" },
  { value: "idle", labelKey: "ui2.agents.filter.status.idle" },
  { value: "running", labelKey: "ui2.agents.filter.status.running" },
  { value: "error", labelKey: "ui2.agents.filter.status.error" },
  { value: "terminated", labelKey: "ui2.agents.filter.status.terminated" },
];

const INPUT_CLASS = "ui2-input w-full rounded-md border border-border bg-background px-2 py-1 text-sm";

export function Ui2AgentsFleetPage() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const [searchDraft, setSearchDraft] = useState("");
  const search = useDebouncedValue(searchDraft.trim(), 300);
  const [statusFilter, setStatusFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [reportsToFilter, setReportsToFilter] = useState("");
  const filters = useMemo<AgentListFilters>(() => {
    const next: AgentListFilters = {};
    if (search) next.q = search;
    if (statusFilter) next.status = statusFilter;
    if (roleFilter.trim()) next.role = roleFilter.trim();
    if (reportsToFilter.trim()) next.reportsTo = reportsToFilter.trim();
    return next;
  }, [search, statusFilter, roleFilter, reportsToFilter]);
  const hasFilters = Boolean(filters.q || filters.status || filters.role || filters.reportsTo);
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId, filters),
    queryFn: () => agentsApi.list(companyId, hasFilters ? filters : undefined),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: pollInterval(30_000),
  });
  const agents = agentsQuery.data ?? [];
  const runsQuery = useQuery({
    queryKey: queryKeys.heartbeats(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: 50, limit: 100 }),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: pollInterval(15_000),
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
  // Cyclic reporting chains have no natural root; promote one member only.
  for (const agent of agents) {
    let cursor = agent.id;
    const seen = new Set<string>();
    while (parentByAgent.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentByAgent.get(cursor)!;
    }
    if (seen.has(cursor) && !roots.some((root) => seen.has(root.id))) {
      const cycleRoot = agentsById.get(cursor);
      if (cycleRoot) roots.push(cycleRoot);
    }
  }
  const visited = new Set<string>();
  const renderAgent = (agent: AgentListItem): ReactNode => {
    if (visited.has(agent.id)) return null;
    visited.add(agent.id);
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
      {(childrenByManager.get(agent.id) ?? []).some((child) => !visited.has(child.id)) ? <ul className="ml-5 border-l border-border">{(childrenByManager.get(agent.id) ?? []).filter((child) => !visited.has(child.id)).map((child) => renderAgent(child))}</ul> : null}
    </li>;
  };
  const clearFilters = () => {
    setSearchDraft("");
    setStatusFilter("");
    setRoleFilter("");
    setReportsToFilter("");
  };
  return (
    <Ui2Page title={t("ui2.agents.title" as never)}>
      <div className="mb-4 flex flex-wrap items-center gap-3" data-testid="agents-fleet-filters">
        <input
          type="search"
          className={INPUT_CLASS + " max-w-xs"}
          aria-label={t("ui2.agents.filter.search" as never)}
          placeholder={t("ui2.agents.filter.search" as never)}
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
        />
        <label className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>{t("ui2.agents.status" as never)}</span>
          <select
            className={INPUT_CLASS + " w-auto"}
            aria-label={t("ui2.agents.filter.status.label" as never)}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            {FLEET_STATUSES.map((option) => (
              <option key={option.value || "all"} value={option.value}>{t(option.labelKey as never)}</option>
            ))}
          </select>
        </label>
        <input
          className={INPUT_CLASS + " max-w-40"}
          aria-label={t("ui2.agents.filter.role" as never)}
          placeholder={t("ui2.agents.filter.role" as never)}
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value)}
        />
        <input
          className={INPUT_CLASS + " max-w-40"}
          aria-label={t("ui2.agents.filter.reportsTo" as never)}
          placeholder={t("ui2.agents.filter.reportsTo" as never)}
          value={reportsToFilter}
          onChange={(event) => setReportsToFilter(event.target.value)}
        />
        {hasFilters ? (
          <button type="button" className="text-sm underline underline-offset-2" onClick={clearFilters}>
            {t("ui2.agents.filter.clear" as never)}
          </button>
        ) : null}
      </div>
      {agentsQuery.isLoading ? <Ui2SkeletonRows rows={6} /> : null}
      {agentsQuery.isError ? <Ui2ErrorState message={t("ui2.common.error" as never)} retryLabel={t("ui2.common.retry" as never)} onRetry={() => void agentsQuery.refetch()} /> : null}
      {agentsQuery.isSuccess && agents.length === 0 ? (
        hasFilters
          ? <Ui2EmptyStateView title={t("ui2.common.emptyFilteredSr" as never)} variant="done" />
          : <Ui2EmptyStateView title={t("ui2.agents.empty" as never)} variant="done" />
      ) : null}
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
