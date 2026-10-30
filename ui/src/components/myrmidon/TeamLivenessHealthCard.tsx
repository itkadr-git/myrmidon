// myrmidon(TEAM-LIVENESS-METRICS): the "Team liveness" 24-hour card.
//
// One card on the company settings (health) page: what the board did on its
// own in the last day for this company — agents it resumed out of `error`,
// agents whose resume attempts ran out, wakes it created, and runs
// progress-based run liveness interrupted. The numbers come from the rows the
// three behaviours already write (activity log, wake requests, run error
// code), so the card cannot drift from the behaviour it describes.
//
// Read-only: the operator changes the behaviour in the "Team liveness" panel
// above, not here.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { i18n, useTranslation } from "@/i18n";
import {
  teamLivenessApi,
  teamLivenessMetricsKey,
  type TeamLivenessMetrics,
} from "./teamLivenessApi";

export interface TeamLivenessHealthCardViewProps {
  metrics: TeamLivenessMetrics | null;
  loading: boolean;
  error: string | null;
}

interface MetricLine {
  key: string;
  label: string;
  value: number;
  hint: string;
}

/** The four counters in reading order, with the label the card shows. */
export function metricLines(metrics: TeamLivenessMetrics): MetricLine[] {
  return [
    {
      key: "autoResumes",
      label: i18n.t("area.settings-models-runtime-2.team-liveness-health-card.autoResumes.label"),
      value: metrics.autoResumes,
      hint: i18n.t("area.settings-models-runtime-2.team-liveness-health-card.autoResumes.hint"),
    },
    {
      key: "autoResumeExhaustions",
      label: i18n.t("area.settings-models-runtime-2.team-liveness-health-card.autoResumeExhaustions.label"),
      value: metrics.autoResumeExhaustions,
      hint: i18n.t("area.settings-models-runtime-2.team-liveness-health-card.autoResumeExhaustions.hint"),
    },
    {
      key: "wakes",
      label: i18n.t("area.settings-models-runtime-2.team-liveness-health-card.wakes.label"),
      value: metrics.wakes,
      hint: i18n.t("area.settings-models-runtime-2.team-liveness-health-card.wakes.hint"),
    },
    {
      key: "stalledRuns",
      label: i18n.t("area.settings-models-runtime-2.team-liveness-health-card.stalledRuns.label"),
      value: metrics.stalledRuns,
      hint: i18n.t("area.settings-models-runtime-2.team-liveness-health-card.stalledRuns.hint"),
    },
  ];
}

/** "last 24 h" from the window the server reports. */
export function windowLabel(metrics: TeamLivenessMetrics): string {
  const hours = metrics.windowHours;
  return i18n.t("area.settings-models-runtime-2.team-liveness-health-card.windowLabel", { hours });
}

export function TeamLivenessHealthCardView({
  metrics,
  loading,
  error,
}: TeamLivenessHealthCardViewProps) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-lg border border-border bg-background"
      data-testid="myrmidon-team-liveness-card"
    >
      <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-base font-medium">{t("area.settings-models-runtime-2.team-liveness-health-card.title")}</span>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          {metrics ? windowLabel(metrics) : "…"}
        </span>
      </div>
      <div className="px-5 pb-5 pt-1 space-y-2">
        {loading ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-team-liveness-loading">
            {t("area.settings-models-runtime-2.team-liveness-health-card.loading")}
          </p>
        ) : error ? (
          <p className="text-sm text-destructive" data-testid="myrmidon-team-liveness-error">
            {error}
          </p>
        ) : metrics ? (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="myrmidon-team-liveness-metrics">
              {metricLines(metrics).map((line) => (
                <div key={line.key} className="rounded-md border border-border px-3 py-2">
                  <dt className="text-xs text-muted-foreground" title={line.hint}>
                    {line.label}
                  </dt>
                  <dd
                    className="text-xl font-medium text-foreground"
                    data-testid={`myrmidon-team-liveness-${line.key}`}
                  >
                    {line.value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground/70">
              {t("area.settings-models-runtime-2.team-liveness-health-card.footnote")}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function TeamLivenessHealthCard() {
  const { selectedCompanyId } = useCompany();
  const { data, isLoading, error } = useQuery({
    queryKey: teamLivenessMetricsKey(selectedCompanyId ?? ""),
    queryFn: () => teamLivenessApi.metrics(selectedCompanyId as string),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 60_000,
    retry: false,
  });
  return (
    <TeamLivenessHealthCardView
      metrics={data ?? null}
      loading={isLoading}
      error={error instanceof Error ? error.message : null}
    />
  );
}