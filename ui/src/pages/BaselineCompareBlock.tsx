// myrmidon(1.6.5-BASELINE-COMPARE-UI): the "compare with the pinned snapshot"
// block on the Quality page. Reads GET /api/myrmidon/companies/:id/baseline/
// compare (merged in 1.6.2) for the same window as the page preset
// and renders, per group (project or role): the current window value, the
// pinned snapshot value and the delta. No pinned snapshot is a normal state
// ("no baseline yet"), not an error; a failed compare request shows a
// separate error state and never breaks the metrics tables above it.
//
// The server's `differences` block aggregates both dimensions into one set
// of company-wide deltas; the per-row numbers here are computed locally from
// `current.by*` against `baseline.by*` rows matched by key (a row missing on
// either side shows no delta — nothing to compare against).
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import {
  baselineApi,
  baselineCompareKey,
  type BaselineComparisonResult,
  type BaselineMetricRow,
  type BaselineMetricsReport,
} from "@/api/baseline";
import { rowKeyLabel } from "./Quality";

type Translator = (key: string, params?: Record<string, unknown>) => string;

type CompareMetric = "tasksDone" | "cycleTime" | "reviewTime" | "returnRate" | "costPerTask";

const METRIC_ORDER: CompareMetric[] = ["tasksDone", "cycleTime", "reviewTime", "returnRate", "costPerTask"];

const METRIC_LABEL_KEYS: Record<CompareMetric, string> = {
  tasksDone: "quality.compare.columns.tasksDone",
  cycleTime: "quality.compare.columns.cycleTime",
  reviewTime: "quality.compare.columns.reviewTime",
  returnRate: "quality.compare.columns.returnRate",
  costPerTask: "quality.compare.columns.costPerTask",
};

function metricValue(row: BaselineMetricRow, metric: CompareMetric, hoursUnit: string): string {
  switch (metric) {
    case "tasksDone":
      return String(row.tasksCompleted);
    case "cycleTime":
      return `${row.cycleTimeHours.mean.toFixed(2)} ${hoursUnit}`;
    case "reviewTime":
      return `${row.timeInReviewHours.mean.toFixed(2)} ${hoursUnit}`;
    case "returnRate":
      return row.returnRate.enteredReview > 0 ? `${(row.returnRate.rate * 100).toFixed(0)}%` : "—";
    case "costPerTask":
      return formatCents(row.costPerTask.meanCents);
  }
}

interface Delta {
  absolute: number;
  percentage: number;
}

function metricDelta(current: BaselineMetricRow, baseline: BaselineMetricRow, metric: CompareMetric): Delta | null {
  switch (metric) {
    case "tasksDone":
      return diff(current.tasksCompleted, baseline.tasksCompleted);
    case "cycleTime":
      return diff(current.cycleTimeHours.mean, baseline.cycleTimeHours.mean);
    case "reviewTime":
      return diff(current.timeInReviewHours.mean, baseline.timeInReviewHours.mean);
    case "returnRate":
      if (current.returnRate.enteredReview === 0 || baseline.returnRate.enteredReview === 0) return null;
      return diff(current.returnRate.rate, baseline.returnRate.rate);
    case "costPerTask":
      return diff(current.costPerTask.meanCents, baseline.costPerTask.meanCents);
  }
}

function diff(current: number, baseline: number): Delta | null {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) {
    if (current === 0) return { absolute: 0, percentage: 0 };
    return null; // no meaningful percentage against a zero baseline
  }
  const absolute = current - baseline;
  return { absolute, percentage: (absolute / baseline) * 100 };
}

/** Lower is better for every metric we compare except tasksDone. */
function isImprovement(metric: CompareMetric, delta: Delta): boolean {
  if (delta.absolute === 0) return true;
  return metric === "tasksDone" ? delta.absolute > 0 : delta.absolute < 0;
}

function formatDelta(metric: CompareMetric, delta: Delta | null, t: Translator, hoursUnit: string): string {
  if (!delta) return t("quality.compare.noDelta");
  const sign = delta.absolute > 0 ? "+" : delta.absolute < 0 ? "−" : "±";
  const absValue = Math.abs(delta.absolute);
  let absoluteText: string;
  switch (metric) {
    case "tasksDone":
      absoluteText = String(Math.round(absValue));
      break;
    case "cycleTime":
    case "reviewTime":
      absoluteText = `${absValue.toFixed(2)} ${hoursUnit}`;
      break;
    case "returnRate":
      absoluteText = `${(absValue * 100).toFixed(1)} ${t("quality.compare.percentPoints")}`;
      break;
    case "costPerTask":
      absoluteText = formatCents(absValue);
      break;
  }
  const percentText = `${Math.abs(delta.percentage).toFixed(1)}%`;
  return `${sign}${absoluteText} (${sign}${percentText})`;
}

function deltaToneClass(metric: CompareMetric, delta: Delta | null): string {
  if (!delta || delta.absolute === 0) return "text-muted-foreground";
  return isImprovement(metric, delta) ? "text-emerald-600 dark:text-emerald-400" : "text-destructive";
}

function indexRows(rows: BaselineMetricRow[]): Map<string | null, BaselineMetricRow> {
  const map = new Map<string | null, BaselineMetricRow>();
  for (const row of rows) map.set(row.key, row);
  return map;
}

interface CompareGroupTableProps {
  title: string;
  current: BaselineMetricRow[];
  baseline: BaselineMetricRow[];
  keyHeader: string;
  rowTestId: string;
  t: Translator;
  hoursUnit: string;
}

function CompareGroupTable({ title, current, baseline, keyHeader, rowTestId, t, hoursUnit }: CompareGroupTableProps) {
  const baselineByKey = indexRows(baseline);
  const keys: (string | null)[] = [];
  const seen = new Set<string | null>();
  for (const row of [...current, ...baseline]) {
    if (!seen.has(row.key)) {
      seen.add(row.key);
      keys.push(row.key);
    }
  }
  const currentByKey = indexRows(current);

  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-foreground">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid={rowTestId}>
          <thead>
            <tr className="border-b border-border bg-accent/20">
              <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">{keyHeader}</th>
              <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">{t("quality.compare.columns.metric")}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.compare.columns.current")}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.compare.columns.baseline")}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">{t("quality.compare.columns.delta")}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const currentRow = currentByKey.get(key) ?? null;
              const baselineRow = baselineByKey.get(key) ?? null;
              return METRIC_ORDER.map((metric, metricIndex) => {
                const delta = currentRow && baselineRow ? metricDelta(currentRow, baselineRow, metric) : null;
                return (
                  <tr key={`${key ?? "__none__"}-${metric}`} className="border-b border-border last:border-b-0">
                    {metricIndex === 0 ? (
                      <td className="px-3 py-2 font-mono align-top" rowSpan={METRIC_ORDER.length}>
                        {rowKeyLabel(key, t)}
                      </td>
                    ) : null}
                    <td className="px-3 py-2 text-muted-foreground">{t(METRIC_LABEL_KEYS[metric])}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {currentRow ? metricValue(currentRow, metric, hoursUnit) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {baselineRow ? metricValue(baselineRow, metric, hoursUnit) : "—"}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${deltaToneClass(metric, delta)}`}>
                      {formatDelta(metric, delta, t, hoursUnit)}
                    </td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface BaselineCompareBlockProps {
  companyId: string;
  from?: string;
  to?: string;
  t: Translator;
}

export function BaselineCompareBlock({ companyId, from, to, t }: BaselineCompareBlockProps) {
  const hoursUnit = t("quality.hoursUnit");
  const { data, isLoading, error } = useQuery<BaselineComparisonResult>({
    queryKey: baselineCompareKey(companyId, from, to),
    queryFn: () => baselineApi.compare(companyId, from, to),
    staleTime: 30_000,
  });

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <p className="text-sm text-muted-foreground" data-testid="quality-compare-loading">
        {t("quality.compare.loading")}
      </p>
    );
  } else if (error) {
    body = (
      <p className="text-sm text-destructive" data-testid="quality-compare-error">
        {t("quality.compare.error")}
      </p>
    );
  } else if (!data || !data.baseline) {
    body = (
      <p className="text-sm text-muted-foreground" data-testid="quality-compare-no-baseline">
        {t("quality.compare.noBaseline")}
      </p>
    );
  } else {
    const current: BaselineMetricsReport = data.current;
    const baseline: BaselineMetricsReport = data.baseline;
    body = (
      <div className="space-y-5" data-testid="quality-compare">
        <p className="text-xs text-muted-foreground" data-testid="quality-compare-snapshot-meta">
          {t("quality.compare.baselineMeta", { window: `${baseline.window.from} – ${baseline.window.to}` })}
        </p>
        <CompareGroupTable
          title={t("quality.compare.byProject")}
          current={current.byProject}
          baseline={baseline.byProject}
          keyHeader={t("quality.columns.project")}
          rowTestId="quality-compare-by-project-table"
          t={t}
          hoursUnit={hoursUnit}
        />
        <CompareGroupTable
          title={t("quality.compare.byRole")}
          current={current.byRole}
          baseline={baseline.byRole}
          keyHeader={t("quality.columns.role")}
          rowTestId="quality-compare-by-role-table"
          t={t}
          hoursUnit={hoursUnit}
        />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{t("quality.compare.title")}</CardTitle>
        <CardDescription>{t("quality.compare.description")}</CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">{body}</CardContent>
    </Card>
  );
}
