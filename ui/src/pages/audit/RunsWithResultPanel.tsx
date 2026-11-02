import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRun } from "@myrmidon/shared";
import { Activity, CircleDotDashed } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useSearchParams } from "@/lib/router";
import { relativeTime } from "@/lib/utils";
import { useTranslation } from "@/i18n";

const ALL = "__all";
const RUN_LIMIT = 200;

const COMMON_WAKE_REASONS = [
  "issue_assigned",
  "issue_commented",
  "timer",
  "idle_pickup",
  "review_requested",
  "ci_finished",
  "manual",
  "recovery",
];

export function getRunResult(run: HeartbeatRun): string | null {
  const result = run.resultJson as { summary?: unknown; result?: unknown; message?: unknown } | null;
  const value = result?.summary ?? result?.result ?? result?.message ?? run.error;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function getRunWakeReason(run: HeartbeatRun): string {
  const fromSnapshot = run.contextSnapshot?.wakeReason;
  if (typeof fromSnapshot === "string" && fromSnapshot.trim()) {
    return fromSnapshot.trim();
  }
  if (typeof run.triggerDetail === "string" && run.triggerDetail.trim()) {
    return run.triggerDetail.trim();
  }
  return run.invocationSource ?? "unknown";
}

export function formatWakeReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

export interface RunsWithResultPanelProps {
  companyId: string;
}

export function RunsWithResultPanel({ companyId }: RunsWithResultPanelProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentId = searchParams.get("agentId") ?? ALL;
  const wakeReason = searchParams.get("wakeReason") ?? ALL;

  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const runs = useQuery({
    queryKey: queryKeys.audit.runs(
      companyId,
      agentId === ALL ? null : agentId,
      wakeReason === ALL ? null : wakeReason,
      true,
    ),
    queryFn: () =>
      heartbeatsApi.list(companyId, agentId === ALL ? undefined : agentId, RUN_LIMIT, {
        wakeReason: wakeReason === ALL ? undefined : wakeReason,
        hasResult: true,
      }),
    refetchInterval: 15_000,
  });

  const agentById = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );

  const wakeReasons = useMemo(() => {
    const set = new Set(COMMON_WAKE_REASONS);
    for (const run of runs.data ?? []) {
      const reason = getRunWakeReason(run);
      if (reason && reason !== "unknown") set.add(reason);
    }
    return Array.from(set).sort();
  }, [runs.data]);

  const visibleRuns = useMemo(() => {
    return (runs.data ?? []).filter((run) => {
      if (agentId !== ALL && run.agentId !== agentId) return false;
      if (wakeReason !== ALL && getRunWakeReason(run) !== wakeReason) return false;
      return true;
    });
  }, [runs.data, agentId, wakeReason]);

  const updateFilter = (key: "agentId" | "wakeReason", value: string) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === ALL) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };

  const clearFilters = () => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("agentId");
        next.delete("wakeReason");
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className="space-y-4" data-testid="runs-with-result-panel">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t(
            "area.search-timeline-audit-2.audit-runs.resultsPanel.title",
            "Runs with result",
          )}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t(
            "area.search-timeline-audit-2.audit-runs.resultsPanel.description",
            "Heartbeat runs that completed with a result, filtered by agent and wake reason.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-y border-border py-3">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          <span>{t("area.search-timeline-audit-2.audit-runs.page.agent", "Agent")}</span>
          <Select
            value={agentId}
            onValueChange={(value) => updateFilter("agentId", value)}
          >
            <SelectTrigger className="w-48" aria-label="Filter by agent">
              <SelectValue
                placeholder={t(
                  "area.search-timeline-audit-2.audit-runs.page.allAgents",
                  "All agents",
                )}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t(
                  "area.search-timeline-audit-2.audit-runs.page.allAgents",
                  "All agents",
                )}
              </SelectItem>
              {(agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          <span>
            {t(
              "area.search-timeline-audit-2.audit-runs.resultsPanel.wakeReason",
              "Wake reason",
            )}
          </span>
          <Select
            value={wakeReason}
            onValueChange={(value) => updateFilter("wakeReason", value)}
          >
            <SelectTrigger className="w-48" aria-label="Filter by wake reason">
              <SelectValue
                placeholder={t(
                  "area.search-timeline-audit-2.audit-runs.resultsPanel.allReasons",
                  "All wake reasons",
                )}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {t(
                  "area.search-timeline-audit-2.audit-runs.resultsPanel.allReasons",
                  "All wake reasons",
                )}
              </SelectItem>
              {wakeReasons.map((reason) => (
                <SelectItem key={reason} value={reason}>
                  {formatWakeReason(reason)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {agentId !== ALL || wakeReason !== ALL ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {t(
              "area.search-timeline-audit-2.audit-runs.page.clearFilters",
              "Clear filters",
            )}
          </Button>
        ) : null}
      </div>

      {runs.isLoading ? (
        <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
          {t("area.search-timeline-audit-2.audit-runs.page.loading", "Loading runs...")}
        </div>
      ) : runs.error ? (
        <div className="flex flex-col items-center gap-3 border-y border-border py-14 text-center">
          <p className="text-sm text-muted-foreground">
            {runs.error instanceof Error
              ? runs.error.message
              : t(
                  "area.search-timeline-audit-2.audit-runs.page.loadFailed",
                  "Failed to load runs",
                )}
          </p>
          <Button variant="outline" size="sm" onClick={() => runs.refetch()}>
            {t("area.search-timeline-audit-2.audit-runs.page.tryAgain", "Try again")}
          </Button>
        </div>
      ) : visibleRuns.length === 0 ? (
        <EmptyState
          icon={agentId !== ALL || wakeReason !== ALL ? CircleDotDashed : Activity}
          message={
            agentId !== ALL || wakeReason !== ALL
              ? t(
                  "area.search-timeline-audit-2.audit-runs.resultsPanel.emptyFiltered",
                  "No runs with result match the selected filters.",
                )
              : t(
                  "area.search-timeline-audit-2.audit-runs.resultsPanel.empty",
                  "No runs with result found.",
                )
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table
            className="w-full text-left text-sm"
            aria-label={t(
              "area.search-timeline-audit-2.audit-runs.resultsPanel.tableLabel",
              "Runs with result table",
            )}
          >
            <thead className="border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">
                  {t(
                    "area.search-timeline-audit-2.audit-runs.resultsPanel.colRun",
                    "Run",
                  )}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.page.agent", "Agent")}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t(
                    "area.search-timeline-audit-2.audit-runs.resultsPanel.wakeReason",
                    "Wake reason",
                  )}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.page.status", "Status")}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t(
                    "area.search-timeline-audit-2.audit-runs.resultsPanel.colResult",
                    "Result",
                  )}
                </th>
                <th className="px-4 py-3 font-medium">
                  {t(
                    "area.search-timeline-audit-2.audit-runs.resultsPanel.colStarted",
                    "Started",
                  )}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleRuns.map((run) => {
                const agent = agentById.get(run.agentId);
                const reason = getRunWakeReason(run);
                const result = getRunResult(run);
                return (
                  <tr
                    key={run.id}
                    className="transition-colors hover:bg-muted/50"
                    data-testid={`run-row-${run.id}`}
                  >
                    <td className="px-4 py-3 font-mono text-xs font-semibold">
                      <Link
                        to={`/agents/${run.agentId}/runs/${run.id}`}
                        className="text-primary hover:underline"
                        aria-label={`View run ${run.id.slice(0, 8)}`}
                      >
                        {run.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-foreground">
                      {agent?.name ??
                        t(
                          "area.search-timeline-audit-2.audit-runs.page.unknownAgent",
                          "Unknown agent",
                        )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                        {formatWakeReason(reason)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="max-w-md truncate px-4 py-3 text-xs text-foreground" title={result ?? ""}>
                      {result ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                      <time dateTime={new Date(run.createdAt).toISOString()}>
                        {relativeTime(run.createdAt)}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t("area.search-timeline-audit-2.audit-runs.page.footer", {
          limit: RUN_LIMIT,
        })}
      </p>
    </div>
  );
}
