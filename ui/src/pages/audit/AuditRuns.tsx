import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRun, RoutineRunSummary } from "@paperclipai/shared";
import { Activity, CircleDotDashed } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { routinesApi } from "@/api/routines";
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
import { i18n, useTranslation } from "@/i18n";

const ALL = "__all";
const RUN_LIMIT = 200;

function runSummary(run: HeartbeatRun) {
  const result = run.resultJson as { summary?: unknown; result?: unknown } | null;
  const value = result?.summary ?? result?.result ?? run.error;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runDuration(run: HeartbeatRun) {
  const start = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return i18n.t("area.search-timeline-audit-2.audit-runs.duration.seconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  return i18n.t("area.search-timeline-audit-2.audit-runs.duration.minutes", { minutes, seconds: seconds % 60 });
}

function readableSource(source: string) {
  return source.replaceAll("_", " ");
}

function routineRunTitle(run: RoutineRunSummary) {
  return run.linkedIssue?.title ?? run.trigger?.label ?? i18n.t("area.search-timeline-audit-2.audit-runs.routineRunFallback");
}

function RoutineScopedRuns({
  runs,
  isLoading,
  error,
  onRetry,
}: {
  runs: RoutineRunSummary[];
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
        {t("area.search-timeline-audit-2.audit-runs.routineScoped.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 border-y border-border py-14 text-center">
        <p className="text-sm text-muted-foreground">{error.message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>{t("area.search-timeline-audit-2.audit-runs.routineScoped.tryAgain")}</Button>
      </div>
    );
  }

  if (runs.length === 0) {
    return <EmptyState icon={Activity} message={t("area.search-timeline-audit-2.audit-runs.routineScoped.empty")} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("area.search-timeline-audit-2.audit-runs.routineScoped.title")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t("area.search-timeline-audit-2.audit-runs.routineScoped.description")}
        </p>
      </div>
      <ul className="divide-y divide-border border-y border-border" aria-label={t("area.search-timeline-audit-2.audit-runs.routineScoped.listLabel")}>
        {runs.map((run) => {
          const content = (
            <>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{routineRunTitle(run)}</span>
                  <StatusBadge status={run.status} />
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {run.trigger?.label ?? readableSource(run.source)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:justify-end">
                <span className="capitalize">{readableSource(run.source)}</span>
                <time dateTime={new Date(run.triggeredAt).toISOString()}>
                  {relativeTime(run.triggeredAt)}
                </time>
              </div>
            </>
          );
          const rowClassName = "flex flex-col gap-2 px-1 py-3 text-inherit no-underline transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:justify-between sm:px-3";
          return (
            <li key={run.id}>
              {run.linkedIssue ? (
                <Link to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className={rowClassName}>
                  {content}
                </Link>
              ) : (
                <div className={rowClassName}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{t("area.search-timeline-audit-2.audit-runs.routineScoped.footer", { limit: RUN_LIMIT })}</p>
    </div>
  );
}

export function AuditRuns({ companyId, routineId }: { companyId: string; routineId?: string }) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentId = searchParams.get("agentId") ?? ALL;
  const status = searchParams.get("runStatus") ?? ALL;
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !routineId,
  });
  const runs = useQuery({
    queryKey: queryKeys.audit.runs(companyId, agentId === ALL ? null : agentId),
    queryFn: () =>
      heartbeatsApi.list(companyId, agentId === ALL ? undefined : agentId, RUN_LIMIT, {
        summary: true,
      }),
    refetchInterval: 15_000,
    enabled: !routineId,
  });
  const routineRuns = useQuery({
    queryKey: [...queryKeys.routines.runs(routineId ?? ""), "audit"],
    queryFn: () => routinesApi.listRuns(routineId!, RUN_LIMIT),
    enabled: Boolean(routineId),
    refetchInterval: 15_000,
  });
  const agentById = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
  const statuses = useMemo(
    () => Array.from(new Set((runs.data ?? []).map((run) => run.status))).sort(),
    [runs.data],
  );
  const visibleRuns = useMemo(
    () => (runs.data ?? []).filter((run) => status === ALL || run.status === status),
    [runs.data, status],
  );

  const updateFilter = (key: "agentId" | "runStatus", value: string) => {
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
        next.delete("runStatus");
        return next;
      },
      { replace: true },
    );
  };

  if (routineId) {
    return (
      <RoutineScopedRuns
        runs={routineRuns.data ?? []}
        isLoading={routineRuns.isLoading}
        error={routineRuns.error instanceof Error ? routineRuns.error : null}
        onRetry={() => void routineRuns.refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("area.search-timeline-audit-2.audit-runs.page.title")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t("area.search-timeline-audit-2.audit-runs.page.description")}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-y border-border py-3">
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>{t("area.search-timeline-audit-2.audit-runs.page.agent")}</span>
          <Select value={agentId} onValueChange={(value) => updateFilter("agentId", value)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder={t("area.search-timeline-audit-2.audit-runs.page.allAgents")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("area.search-timeline-audit-2.audit-runs.page.allAgents")}</SelectItem>
              {(agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>{t("area.search-timeline-audit-2.audit-runs.page.status")}</span>
          <Select value={status} onValueChange={(value) => updateFilter("runStatus", value)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder={t("area.search-timeline-audit-2.audit-runs.page.allStatuses")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("area.search-timeline-audit-2.audit-runs.page.allStatuses")}</SelectItem>
              {statuses.map((value) => (
                <SelectItem key={value} value={value}>
                  {readableSource(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {agentId !== ALL || status !== ALL ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {t("area.search-timeline-audit-2.audit-runs.page.clearFilters")}
          </Button>
        ) : null}
      </div>

      {runs.isLoading ? (
        <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
          {t("area.search-timeline-audit-2.audit-runs.page.loading")}
        </div>
      ) : runs.error ? (
        <div className="flex flex-col items-center gap-3 border-y border-border py-14 text-center">
          <p className="text-sm text-muted-foreground">
            {runs.error instanceof Error ? runs.error.message : t("area.search-timeline-audit-2.audit-runs.page.loadFailed")}
          </p>
          <Button variant="outline" size="sm" onClick={() => runs.refetch()}>
            {t("area.search-timeline-audit-2.audit-runs.page.tryAgain")}
          </Button>
        </div>
      ) : visibleRuns.length === 0 ? (
        <EmptyState
          icon={agentId !== ALL || status !== ALL ? CircleDotDashed : Activity}
          message={agentId !== ALL || status !== ALL ? t("area.search-timeline-audit-2.audit-runs.page.emptyFiltered") : t("area.search-timeline-audit-2.audit-runs.page.empty")}
        />
      ) : (
        <ul className="divide-y divide-border border-y border-border" aria-label={t("area.search-timeline-audit-2.audit-runs.page.listLabel")}>
          {visibleRuns.map((run) => {
            const agent = agentById.get(run.agentId);
            const summary = runSummary(run);
            const duration = runDuration(run);
            return (
              <li key={run.id}>
                <Link
                  to={`/agents/${run.agentId}/runs/${run.id}`}
                  className="flex flex-col gap-2 px-1 py-3 text-inherit no-underline transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:justify-between sm:px-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {agent?.name ?? t("area.search-timeline-audit-2.audit-runs.page.unknownAgent")}
                      </span>
                      <span className="font-mono text-(length:--text-micro) text-muted-foreground">
                        {run.id.slice(0, 8)}
                      </span>
                      <StatusBadge status={run.status} />
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {summary ?? t("area.search-timeline-audit-2.audit-runs.page.sourceRun", { source: readableSource(run.invocationSource) })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:justify-end">
                    <span className="capitalize">{readableSource(run.invocationSource)}</span>
                    {duration ? <span>{duration}</span> : null}
                    <time dateTime={new Date(run.createdAt).toISOString()}>
                      {relativeTime(run.createdAt)}
                    </time>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">{t("area.search-timeline-audit-2.audit-runs.page.footer", { limit: RUN_LIMIT })}</p>
    </div>
  );
}
