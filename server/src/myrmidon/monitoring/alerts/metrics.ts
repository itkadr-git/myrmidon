// server/src/myrmidon/monitoring/alerts/metrics.ts
// myrmidon(1.6.6-ALERTS): the processed-alerts counter the annex asks for.
// In-memory, per-process, reset on restart — the /metrics endpoint of part A
// collects it by calling alertsMetricsSnapshot() from the wired routes. No
// storage, no migration.

export const ALERTS_METRIC_NAME = "myrmidon_alerts_processed_total";
export type AlertMetricResult = "created" | "updated" | "closed" | "dedup" | "error";

export interface AlertsMetrics {
  record(result: AlertMetricResult): void;
  snapshot(): Record<AlertMetricResult, number>;
}

export function createAlertsMetrics(): AlertsMetrics {
  const counters: Record<AlertMetricResult, number> = {
    created: 0,
    updated: 0,
    closed: 0,
    dedup: 0,
    error: 0,
  };
  return {
    record(result) {
      counters[result] += 1;
    },
    snapshot() {
      return { ...counters };
    },
  };
}

/** Maps a service outcome action to the metric result label. */
export function outcomeToMetric(action: "create" | "update" | "resolve" | "ignore"): AlertMetricResult {
  switch (action) {
    case "create": return "created";
    case "update": return "updated";
    case "resolve": return "closed";
    case "ignore": return "dedup";
  }
}
