import { useMemo, useState } from "react";
import { Activity as ActivityIcon, Play, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { i18n, useTranslation } from "@/i18n";
import { timeAgo } from "../../lib/timeAgo";
import { runRowSubtitle, dedupedTriggerLabel } from "../../lib/routine-run-display";
import { EmptyState } from "../EmptyState";
import { EntityRow } from "../EntityRow";
import { FilterBar, type FilterValue } from "../FilterBar";
import { LiveRunWidget } from "../LiveRunWidget";
import { RoutineHistoryTab } from "../RoutineHistoryTab";
import { RoutineActivityRow } from "../RoutineActivityRow";
import { useRoutineDetail } from "./context";

const DATE_WINDOW_OPTIONS = (): { value: string; label: string; ms: number | null }[] => [
  { value: "any", label: i18n.t("area.routines-2.operate-sections.dateAny"), ms: null },
  { value: "24h", label: i18n.t("area.routines-2.operate-sections.date24h"), ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: i18n.t("area.routines-2.operate-sections.date7d"), ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: i18n.t("area.routines-2.operate-sections.date30d"), ms: 30 * 24 * 60 * 60 * 1000 },
];

export function RunsSection() {
  const { t } = useTranslation();
  const dateWindowOptions = DATE_WINDOW_OPTIONS();
  const ctx = useRoutineDetail();
  const { routine, routineRuns, hasLiveRun, activeIssueId, onOpenRunDialog } = ctx;
  const runs = useMemo(() => routineRuns ?? [], [routineRuns]);

  const [sourceFilter, setSourceFilter] = useState("any");
  const [statusFilter, setStatusFilter] = useState("any");
  const [dateFilter, setDateFilter] = useState("any");

  const sourceOptions = useMemo(
    () => [...new Set(runs.map((run) => run.source))].sort(),
    [runs],
  );
  const statusOptions = useMemo(
    () => [...new Set(runs.map((run) => run.status))].sort(),
    [runs],
  );

  const filtered = useMemo(() => {
    const windowMs = dateWindowOptions.find((option) => option.value === dateFilter)?.ms ?? null;
    const cutoff = windowMs == null ? null : Date.now() - windowMs;
    return runs.filter((run) => {
      if (sourceFilter !== "any" && run.source !== sourceFilter) return false;
      if (statusFilter !== "any" && run.status !== statusFilter) return false;
      if (cutoff != null && new Date(run.triggeredAt).getTime() < cutoff) return false;
      return true;
    });
  }, [runs, sourceFilter, statusFilter, dateFilter, dateWindowOptions]);

  const activeFilters = useMemo<FilterValue[]>(() => {
    const list: FilterValue[] = [];
    if (sourceFilter !== "any") list.push({ key: "source", label: t("area.routines-2.operate-sections.source"), value: sourceFilter });
    if (statusFilter !== "any") {
      list.push({ key: "status", label: t("area.routines-2.operate-sections.status"), value: statusFilter.replaceAll("_", " ") });
    }
    if (dateFilter !== "any") {
      const label = dateWindowOptions.find((option) => option.value === dateFilter)?.label ?? dateFilter;
      list.push({ key: "date", label: t("area.routines-2.operate-sections.date"), value: label });
    }
    return list;
  }, [sourceFilter, statusFilter, dateFilter, dateWindowOptions, t]);

  function clearFilters() {
    setSourceFilter("any");
    setStatusFilter("any");
    setDateFilter("any");
  }

  function removeFilter(key: string) {
    if (key === "source") setSourceFilter("any");
    if (key === "status") setStatusFilter("any");
    if (key === "date") setDateFilter("any");
  }

  return (
    <div className="space-y-4">
      {hasLiveRun && activeIssueId ? (
        <LiveRunWidget issueId={activeIssueId} companyId={routine.companyId} />
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          icon={Play}
          message={t("area.routines-2.operate-sections.noRuns")}
          action={t("area.routines-2.operate-sections.runNow")}
          onAction={onOpenRunDialog}
        />
      ) : (
        <>
          {/* Filter chips row (§3.6) */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger size="sm" className="h-8 w-auto gap-1.5 text-xs" aria-label={t("area.routines-2.operate-sections.filterSourceAria")}>
                  <span className="text-muted-foreground">{t("area.routines-2.operate-sections.sourceLabel")}</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">{t("area.routines-2.operate-sections.anyOption")}</SelectItem>
                  {sourceOptions.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger size="sm" className="h-8 w-auto gap-1.5 text-xs" aria-label={t("area.routines-2.operate-sections.filterStatusAria")}>
                  <span className="text-muted-foreground">{t("area.routines-2.operate-sections.statusLabel")}</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">{t("area.routines-2.operate-sections.anyOption")}</SelectItem>
                  {statusOptions.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={dateFilter} onValueChange={setDateFilter}>
                <SelectTrigger size="sm" className="h-8 w-auto gap-1.5 text-xs" aria-label={t("area.routines-2.operate-sections.filterDateAria")}>
                  <span className="text-muted-foreground">{t("area.routines-2.operate-sections.dateLabel")}</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dateWindowOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FilterBar filters={activeFilters} onRemove={removeFilter} onClear={clearFilters} />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={SlidersHorizontal}
              message={t("area.routines-2.operate-sections.noMatch")}
              action={t("area.routines-2.operate-sections.clearFilters")}
              onAction={clearFilters}
            />
          ) : (
            <div className="rounded-lg border border-border">
              {filtered.map((run) => {
                const label = dedupedTriggerLabel(run.trigger);
                const title = run.linkedIssue?.title ?? label ?? t("area.routines-2.operate-sections.defaultRunTitle");
                return (
                  <EntityRow
                    key={run.id}
                    leading={
                      <>
                        <Badge variant="outline" className="shrink-0">
                          {run.source}
                        </Badge>
                        <Badge
                          variant={run.status === "failed" ? "destructive" : "secondary"}
                          className="shrink-0"
                        >
                          {run.status.replaceAll("_", " ")}
                        </Badge>
                      </>
                    }
                    identifier={
                      run.linkedIssue
                        ? run.linkedIssue.identifier ?? run.linkedIssue.id.slice(0, 8)
                        : undefined
                    }
                    title={title}
                    subtitle={runRowSubtitle(run, routine.variables)}
                    reserveSubtitleSpace
                    trailing={
                      <span className="text-xs text-muted-foreground">{timeAgo(run.triggeredAt)}</span>
                    }
                    to={
                      run.linkedIssue
                        ? `/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`
                        : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ActivitySection() {
  const { t } = useTranslation();
  const ctx = useRoutineDetail();
  const { activity } = ctx;
  const events = activity ?? [];

  const groups = useMemo(() => {
    const byDay = new Map<string, typeof events>();
    for (const event of events) {
      let label = t("area.routines-2.operate-sections.earlier");
      try {
        label = new Date(event.createdAt).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      } catch {
        /* keep fallback label */
      }
      const bucket = byDay.get(label) ?? [];
      bucket.push(event);
      byDay.set(label, bucket);
    }
    return Array.from(byDay.entries());
  }, [events, t]);

  if (events.length === 0) {
    return <EmptyState icon={ActivityIcon} message={t("area.routines-2.operate-sections.noActivity")} />;
  }

  return (
    <div className="space-y-4">
      {groups.map(([day, dayEvents]) => (
        <div key={day}>
          <div className="sticky top-0 bg-background py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {day}
          </div>
          <div>
            {dayEvents.map((event) => (
              <RoutineActivityRow key={event.id} event={event} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function HistorySection() {
  const ctx = useRoutineDetail();
  const {
    routine,
    isEditDirty,
    dirtyFields,
    routineDefaults,
    setEditDraft,
    saveRoutine,
    agentById,
    projectById,
    availableSecrets,
    onHistoryRestoreSecretMaterials,
    onHistoryRestored,
  } = ctx;

  return (
    <RoutineHistoryTab
      routine={routine}
      isEditDirty={isEditDirty}
      dirtyFields={dirtyFields}
      onDiscardEdits={() => setEditDraft(routineDefaults)}
      onSaveEdits={() => {
        if (!saveRoutine.isPending && routine.title.trim()) {
          saveRoutine.mutate();
        }
      }}
      agents={agentById}
      projects={projectById}
      secrets={availableSecrets}
      onRestoreSecretMaterials={onHistoryRestoreSecretMaterials}
      onRestored={onHistoryRestored}
    />
  );
}
