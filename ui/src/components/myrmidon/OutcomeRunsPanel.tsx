import * as React from "react";
import { useMemo } from "react";
import type { Agent, HeartbeatRun } from "@myrmidon/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTranslation } from "@/i18n";
import { formatTokens } from "@/lib/utils";
import { CheckCircle2, Coins, TrendingUp, Zap } from "lucide-react";

export type TimeRangePreset = "6h" | "24h" | "48h" | "7d" | "all";

export const ALL_VALUE = "__all";

export interface RunTelemetryMetrics {
  outcomeCategory: string | null;
  isOutcome: boolean;
  isIdle: boolean;
  wakeReason: string;
  modelCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  gatewaySpendUsd: number;
  apiEquivalentCostUsd: number;
  totalCostUsd: number;
}

export interface AggregatedOutcomeMetrics {
  totalRuns: number;
  evaluatedRuns: number;
  outcomeRuns: number;
  idleRuns: number;
  pendingRuns: number;
  outcomeRatePct: number;
  totalModelCalls: number;
  outcomeModelCalls: number;
  idleModelCalls: number;
  totalTokens: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  idleCostUsd: number;
  outcomeCostUsd: number;
  categoryCounts: Record<string, number>;
  reasonsBreakdown: Array<{
    reason: string;
    totalRuns: number;
    outcomeRuns: number;
    idleRuns: number;
    outcomeRatePct: number;
    modelCalls: number;
    totalTokens: number;
    totalCostUsd: number;
    idleCostUsd: number;
  }>;
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

export function formatWakeReason(reason: string): string {
  const map: Record<string, string> = {
    timer: "Timer",
    issue_continuation_needed: "Continuation",
    issue_commented: "Issue comment",
    issue_assigned: "Issue assigned",
    issue_status_changed: "Issue status",
    task_resumed: "Task resumed",
    interaction_resolved: "Interaction",
    automation: "Automation",
    manual: "Manual",
    callback: "Callback",
    webhook: "Webhook",
    routine: "Routine",
  };
  if (map[reason]) return map[reason];
  return reason.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getRunTelemetryMetrics(run: HeartbeatRun): RunTelemetryMetrics {
  const resultJson = run.resultJson as Record<string, unknown> | null | undefined;
  const telemetry = (run.runTelemetry ?? resultJson?.runTelemetry) as Record<string, unknown> | null | undefined;

  const outcomeCategory = typeof telemetry?.outcomeCategory === "string"
    ? telemetry.outcomeCategory
    : (run.status === "succeeded" || run.status === "failed" || run.status === "canceled")
      ? "nothing"
      : null;

  const isOutcome = outcomeCategory === "artifact" ||
    outcomeCategory === "commit_push" ||
    outcomeCategory === "status" ||
    outcomeCategory === "other_work_product";

  const isIdle = outcomeCategory === "comment_only" || outcomeCategory === "nothing";

  const rawWake = (typeof telemetry?.wakeReason === "string" && telemetry.wakeReason) ||
    (typeof (run as unknown as { wakeReason?: string }).wakeReason === "string" && (run as unknown as { wakeReason?: string }).wakeReason) ||
    run.invocationSource ||
    "unknown";
  const wakeReason = rawWake.trim() || "unknown";

  const modelCalls = typeof telemetry?.modelCallCount === "number"
    ? telemetry.modelCallCount
    : Array.isArray(telemetry?.gatewayCallIds)
      ? telemetry.gatewayCallIds.length
      : Array.isArray(telemetry?.litellmRequestIds)
        ? telemetry.litellmRequestIds.length
        : 0;

  const usageJson = (run.usageJson ?? {}) as Record<string, unknown>;
  const inputTokens = typeof telemetry?.inputTokens === "number"
    ? telemetry.inputTokens
    : typeof usageJson.inputTokens === "number"
      ? usageJson.inputTokens
      : 0;

  const cachedInputTokens = typeof telemetry?.cachedInputTokens === "number"
    ? telemetry.cachedInputTokens
    : typeof usageJson.cachedInputTokens === "number"
      ? usageJson.cachedInputTokens
      : 0;

  const outputTokens = typeof telemetry?.outputTokens === "number"
    ? telemetry.outputTokens
    : typeof usageJson.outputTokens === "number"
      ? usageJson.outputTokens
      : 0;

  const totalTokens = inputTokens + cachedInputTokens + outputTokens;

  const gatewaySpendUsd = typeof telemetry?.gatewaySpendCents === "number"
    ? Math.max(0, telemetry.gatewaySpendCents) / 100
    : 0;

  const apiEquivalentCostUsd = typeof telemetry?.apiEquivalentCostUsd === "number"
    ? Math.max(0, telemetry.apiEquivalentCostUsd)
    : 0;

  const totalCostUsd = gatewaySpendUsd + apiEquivalentCostUsd;

  return {
    outcomeCategory,
    isOutcome,
    isIdle,
    wakeReason,
    modelCalls,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    gatewaySpendUsd,
    apiEquivalentCostUsd,
    totalCostUsd,
  };
}

export function filterRunsByTimeRange(
  runs: HeartbeatRun[],
  timeRange: TimeRangePreset,
  now = Date.now(),
): HeartbeatRun[] {
  if (timeRange === "all") return runs;
  const durations: Record<Exclude<TimeRangePreset, "all">, number> = {
    "6h": 6 * 3600 * 1000,
    "24h": 24 * 3600 * 1000,
    "48h": 48 * 3600 * 1000,
    "7d": 7 * 24 * 3600 * 1000,
  };
  const durationMs = durations[timeRange];
  const cutoff = now - durationMs;
  return runs.filter((run) => {
    const runTime = new Date(run.startedAt ?? run.createdAt).getTime();
    return runTime >= cutoff;
  });
}

export function aggregateOutcomeMetrics(runs: HeartbeatRun[]): AggregatedOutcomeMetrics {
  let evaluatedRuns = 0;
  let outcomeRuns = 0;
  let idleRuns = 0;
  let pendingRuns = 0;
  let totalModelCalls = 0;
  let outcomeModelCalls = 0;
  let idleModelCalls = 0;
  let totalInputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let idleCostUsd = 0;
  let outcomeCostUsd = 0;

  const categoryCounts: Record<string, number> = {
    artifact: 0,
    commit_push: 0,
    status: 0,
    other_work_product: 0,
    comment_only: 0,
    nothing: 0,
  };

  const reasonMap = new Map<string, {
    reason: string;
    totalRuns: number;
    outcomeRuns: number;
    idleRuns: number;
    modelCalls: number;
    totalTokens: number;
    totalCostUsd: number;
    idleCostUsd: number;
  }>();

  for (const run of runs) {
    const m = getRunTelemetryMetrics(run);

    totalModelCalls += m.modelCalls;
    totalInputTokens += m.inputTokens;
    totalCachedInputTokens += m.cachedInputTokens;
    totalOutputTokens += m.outputTokens;
    totalTokens += m.totalTokens;
    totalCostUsd += m.totalCostUsd;

    if (m.outcomeCategory) {
      evaluatedRuns += 1;
      if (m.outcomeCategory in categoryCounts) {
        categoryCounts[m.outcomeCategory] += 1;
      }
      if (m.isOutcome) {
        outcomeRuns += 1;
        outcomeModelCalls += m.modelCalls;
        outcomeCostUsd += m.totalCostUsd;
      } else if (m.isIdle) {
        idleRuns += 1;
        idleModelCalls += m.modelCalls;
        idleCostUsd += m.totalCostUsd;
      }
    } else {
      pendingRuns += 1;
    }

    let rData = reasonMap.get(m.wakeReason);
    if (!rData) {
      rData = {
        reason: m.wakeReason,
        totalRuns: 0,
        outcomeRuns: 0,
        idleRuns: 0,
        modelCalls: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        idleCostUsd: 0,
      };
      reasonMap.set(m.wakeReason, rData);
    }
    rData.totalRuns += 1;
    if (m.isOutcome) rData.outcomeRuns += 1;
    if (m.isIdle) {
      rData.idleRuns += 1;
      rData.idleCostUsd += m.totalCostUsd;
    }
    rData.modelCalls += m.modelCalls;
    rData.totalTokens += m.totalTokens;
    rData.totalCostUsd += m.totalCostUsd;
  }

  const outcomeRatePct = evaluatedRuns > 0 ? (outcomeRuns / evaluatedRuns) * 100 : 0;

  const reasonsBreakdown = Array.from(reasonMap.values()).map((r) => ({
    ...r,
    outcomeRatePct: r.totalRuns > 0 ? (r.outcomeRuns / r.totalRuns) * 100 : 0,
  })).sort((a, b) => b.totalRuns - a.totalRuns);

  return {
    totalRuns: runs.length,
    evaluatedRuns,
    outcomeRuns,
    idleRuns,
    pendingRuns,
    outcomeRatePct,
    totalModelCalls,
    outcomeModelCalls,
    idleModelCalls,
    totalTokens,
    totalInputTokens,
    totalCachedInputTokens,
    totalOutputTokens,
    totalCostUsd,
    idleCostUsd,
    outcomeCostUsd,
    categoryCounts,
    reasonsBreakdown,
  };
}

export function OutcomeBadge({ category }: { category: string | null | undefined }) {
  if (!category) return null;
  switch (category) {
    case "artifact":
      return (
        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          Artifact
        </Badge>
      );
    case "commit_push":
      return (
        <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400">
          Commit / PR
        </Badge>
      );
    case "status":
      return (
        <Badge variant="outline" className="border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          Status
        </Badge>
      );
    case "other_work_product":
      return (
        <Badge variant="outline" className="border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400">
          Work product
        </Badge>
      );
    case "comment_only":
      return (
        <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
          Comment only
        </Badge>
      );
    case "nothing":
      return (
        <Badge variant="outline" className="border-border bg-muted/50 text-muted-foreground">
          Idle
        </Badge>
      );
    default:
      return <Badge variant="outline">{category}</Badge>;
  }
}

export interface OutcomeRunsPanelProps {
  runs: HeartbeatRun[];
  agents: Agent[];
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
  selectedWakeReason?: string;
  onSelectWakeReason?: (wakeReason: string) => void;
  selectedTimeRange?: TimeRangePreset;
  onSelectTimeRange?: (timeRange: TimeRangePreset) => void;
}

export function OutcomeRunsPanel({
  runs,
  agents,
  selectedAgentId = ALL_VALUE,
  onSelectAgent,
  selectedWakeReason = ALL_VALUE,
  onSelectWakeReason,
  selectedTimeRange = "all",
  onSelectTimeRange,
}: OutcomeRunsPanelProps) {
  const { t } = useTranslation();

  const availableWakeReasons = useMemo(() => {
    const set = new Set<string>();
    for (const run of runs) {
      const m = getRunTelemetryMetrics(run);
      if (m.wakeReason && m.wakeReason !== "unknown") {
        set.add(m.wakeReason);
      }
    }
    return Array.from(set).sort();
  }, [runs]);

  // Step 1: Filter by time
  const timeFilteredRuns = useMemo(() => {
    return filterRunsByTimeRange(runs, selectedTimeRange);
  }, [runs, selectedTimeRange]);

  // Step 2: Filter by agent
  const agentFilteredRuns = useMemo(() => {
    if (!selectedAgentId || selectedAgentId === ALL_VALUE) return timeFilteredRuns;
    return timeFilteredRuns.filter((r) => r.agentId === selectedAgentId);
  }, [timeFilteredRuns, selectedAgentId]);

  // Step 3: Filter by wake reason
  const fullyFilteredRuns = useMemo(() => {
    if (!selectedWakeReason || selectedWakeReason === ALL_VALUE) return agentFilteredRuns;
    return agentFilteredRuns.filter((r) => {
      const m = getRunTelemetryMetrics(r);
      return m.wakeReason === selectedWakeReason;
    });
  }, [agentFilteredRuns, selectedWakeReason]);

  // Aggregated metrics on the fully filtered dataset
  const metrics = useMemo(() => {
    return aggregateOutcomeMetrics(fullyFilteredRuns);
  }, [fullyFilteredRuns]);

  // Reasons breakdown from agentFilteredRuns (so table displays all reasons for the current agent/time scope)
  const agentScopedMetrics = useMemo(() => {
    return aggregateOutcomeMetrics(agentFilteredRuns);
  }, [agentFilteredRuns]);

  const timePresets: Array<{ id: TimeRangePreset; labelKey: string }> = [
    { id: "6h", labelKey: "6h" },
    { id: "24h", labelKey: "24h" },
    { id: "48h", labelKey: "48h" },
    { id: "7d", labelKey: "7d" },
    { id: "all", labelKey: "all" },
  ];

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xs" data-testid="outcome-runs-panel">
      {/* Header and Filter Controls */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-emerald-500" />
            <h3 className="text-base font-semibold text-foreground">
              {t("area.search-timeline-audit-2.audit-runs.outcomePanel.title")}
            </h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("area.search-timeline-audit-2.audit-runs.outcomePanel.description")}
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Time range buttons */}
          <div className="flex items-center rounded-lg border border-border bg-muted/40 p-1 text-xs">
            {timePresets.map((preset) => {
              const active = selectedTimeRange === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onSelectTimeRange?.(preset.id)}
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                    active
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`time-filter-${preset.id}`}
                >
                  {t(`area.search-timeline-audit-2.audit-runs.outcomePanel.filters.periods.${preset.labelKey}`)}
                </button>
              );
            })}
          </div>

          {/* Agent filter */}
          {onSelectAgent && (
            <Select value={selectedAgentId} onValueChange={onSelectAgent}>
              <SelectTrigger className="w-40 text-xs">
                <SelectValue placeholder={t("area.search-timeline-audit-2.audit-runs.page.allAgents")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>
                  {t("area.search-timeline-audit-2.audit-runs.page.allAgents")}
                </SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Wake reason filter */}
          {onSelectWakeReason && (
            <Select value={selectedWakeReason} onValueChange={onSelectWakeReason}>
              <SelectTrigger className="w-44 text-xs" data-testid="wake-reason-filter">
                <SelectValue placeholder={t("area.search-timeline-audit-2.audit-runs.outcomePanel.filters.allWakeReasons")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>
                  {t("area.search-timeline-audit-2.audit-runs.outcomePanel.filters.allWakeReasons")}
                </SelectItem>
                {availableWakeReasons.map((reason) => (
                  <SelectItem key={reason} value={reason}>
                    {formatWakeReason(reason)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Outcome Rate */}
        <Card className="border border-border bg-card p-4 shadow-none">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("area.search-timeline-audit-2.audit-runs.outcomePanel.kpi.outcomeRate")}
            </span>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground" data-testid="outcome-rate-value">
            {metrics.outcomeRatePct.toFixed(1)}%
          </div>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="outcome-rate-sub">
            {t("area.search-timeline-audit-2.audit-runs.outcomePanel.kpi.outcomeRateSub", {
              numerator: metrics.outcomeRuns,
              denominator: metrics.evaluatedRuns,
            })}
          </p>
        </Card>

        {/* Model Calls */}
        <Card className="border border-border bg-card p-4 shadow-none">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("area.search-timeline-audit-2.audit-runs.outcomePanel.kpi.modelCalls")}
            </span>
            <Zap className="h-4 w-4 text-sky-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground" data-testid="model-calls-value">
            {metrics.totalModelCalls}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("area.search-timeline-audit-2.audit-runs.outcomePanel.kpi.modelCallsSub", {
              outcomeCalls: metrics.outcomeModelCalls,
              idleCalls: metrics.idleModelCalls,
            })}
          </p>
        </Card>

        {/* Tokens */}
        <Card className="border border-border bg-card p-4 shadow-none">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("area.search-timeline-audit-2.audit-runs.outcomePanel.kpi.tokens")}
            </span>
            <Coins className="h-4 w-4 text-amber-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground" data-testid="total-tokens-value">
            {formatTokens(metrics.totalTokens)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("area.search-timeline-audit-2.audit-runs.outcomePanel.kpi.tokensSub", {
              input: formatTokens(metrics.totalInputTokens),
              cached: formatTokens(metrics.totalCachedInputTokens),
              output: formatTokens(metrics.totalOutputTokens),
            })}
          </p>
        </Card>

        {/* Spend & Idle Cost */}
        <Card className="border border-border bg-card p-4 shadow-none">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("area.search-timeline-audit-2.audit-runs.outcomePanel.kpi.totalCost")}
            </span>
            <Coins className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground" data-testid="total-cost-value">
            {formatUsd(metrics.totalCostUsd)}
          </div>
          <div className="mt-1 flex items-center justify-between text-xs font-medium text-amber-600 dark:text-amber-400" data-testid="idle-cost-value">
            <span>{t("area.search-timeline-audit-2.audit-runs.outcomePanel.kpi.idleCost")}:</span>
            <span className="font-mono">{formatUsd(metrics.idleCostUsd)}</span>
          </div>
        </Card>
      </div>

      {/* Outcome Category Breakdown */}
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("area.search-timeline-audit-2.audit-runs.outcomePanel.categories.title")}
        </h4>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 text-xs">
          <div className="flex items-center justify-between rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5">
            <span className="text-muted-foreground">{t("area.search-timeline-audit-2.audit-runs.outcomePanel.categories.artifact")}</span>
            <span className="font-bold text-foreground">{metrics.categoryCounts.artifact ?? 0}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-blue-500/20 bg-blue-500/5 px-2.5 py-1.5">
            <span className="text-muted-foreground">{t("area.search-timeline-audit-2.audit-runs.outcomePanel.categories.commit_push")}</span>
            <span className="font-bold text-foreground">{metrics.categoryCounts.commit_push ?? 0}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-indigo-500/20 bg-indigo-500/5 px-2.5 py-1.5">
            <span className="text-muted-foreground">{t("area.search-timeline-audit-2.audit-runs.outcomePanel.categories.status")}</span>
            <span className="font-bold text-foreground">{metrics.categoryCounts.status ?? 0}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-purple-500/20 bg-purple-500/5 px-2.5 py-1.5">
            <span className="text-muted-foreground">{t("area.search-timeline-audit-2.audit-runs.outcomePanel.categories.other_work_product")}</span>
            <span className="font-bold text-foreground">{metrics.categoryCounts.other_work_product ?? 0}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5">
            <span className="text-muted-foreground">{t("area.search-timeline-audit-2.audit-runs.outcomePanel.categories.comment_only")}</span>
            <span className="font-bold text-foreground">{metrics.categoryCounts.comment_only ?? 0}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
            <span className="text-muted-foreground">{t("area.search-timeline-audit-2.audit-runs.outcomePanel.categories.nothing")}</span>
            <span className="font-bold text-foreground">{metrics.categoryCounts.nothing ?? 0}</span>
          </div>
        </div>
      </div>

      {/* Wake Reasons Table */}
      {agentScopedMetrics.reasonsBreakdown.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <div className="bg-muted/30 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("area.search-timeline-audit-2.audit-runs.outcomePanel.reasonsTable.title")}
          </div>
          <table className="w-full text-left text-xs" data-testid="reasons-breakdown-table">
            <thead className="border-y border-border bg-muted/20 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.outcomePanel.reasonsTable.wakeReason")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.outcomePanel.reasonsTable.totalRuns")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.outcomePanel.reasonsTable.outcomeRuns")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.outcomePanel.reasonsTable.rate")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.outcomePanel.reasonsTable.calls")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.outcomePanel.reasonsTable.tokens")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.outcomePanel.reasonsTable.totalCost")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("area.search-timeline-audit-2.audit-runs.outcomePanel.reasonsTable.idleCost")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agentScopedMetrics.reasonsBreakdown.map((row) => {
                const isSelected = selectedWakeReason === row.reason;
                return (
                  <tr
                    key={row.reason}
                    onClick={() => {
                      if (!onSelectWakeReason) return;
                      onSelectWakeReason(isSelected ? ALL_VALUE : row.reason);
                    }}
                    className={`cursor-pointer transition-colors hover:bg-muted/40 ${
                      isSelected ? "bg-muted/60 font-semibold" : ""
                    }`}
                    data-testid={`reason-row-${row.reason}`}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">
                          {formatWakeReason(row.reason)}
                        </span>
                        <span className="font-mono text-muted-foreground">({row.reason})</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-foreground">
                      {row.totalRuns}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-foreground">
                      {row.outcomeRuns}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-medium">
                      <span
                        className={
                          row.outcomeRatePct >= 50
                            ? "text-emerald-600 dark:text-emerald-400"
                            : row.outcomeRatePct > 0
                              ? "text-sky-600 dark:text-sky-400"
                              : "text-muted-foreground"
                        }
                      >
                        {row.outcomeRatePct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {row.modelCalls}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {formatTokens(row.totalTokens)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-foreground">
                      {formatUsd(row.totalCostUsd)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-amber-600 dark:text-amber-400">
                      {formatUsd(row.idleCostUsd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
