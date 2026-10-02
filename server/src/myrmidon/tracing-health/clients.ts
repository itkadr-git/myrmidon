// server/src/myrmidon/tracing-health/clients.ts
//
// myrmidon(TRACING-HEALTH): the two read-only probes behind the check.
//
//  - `countEventsCoreSince`: Langfuse v4 keeps traces in the ClickHouse table
//    `events_core` (the query-optimized projection of `events_full`; the old
//    `traces`/`observations` tables are empty by design in `events_only`
//    mode). The probe asks ClickHouse for rows newer than the window start.
//    `start_time` is the event's own clock and has an index; `created_at` is
//    the ingestion write time. We read both and take the maximum, so an event
//    that is written late (OTEL batching, dual-write) still counts, while an
//    event whose clock is ahead cannot hide a delivery gap.
//  - `readLitellmCallbackFailures`: LiteLLM's Prometheus `/metrics` endpoint
//    exposes `litellm_callback_logging_failures_metric` (labels include
//    `callback_name` — `langfuse`, `langfuse_otel`, …). The probe sums the
//    matching series. Prometheus counters are cumulative since process start,
//    so the delta within the window is what the service computes.
//
// Both probes take the credentials as arguments (the wiring reads the company
// secret store), never log values, and put no address or key in an error
// message: a failed probe says which probe failed and the HTTP status.

import type { TracingHealthSettings } from "./settings.js";

export interface EventsCountResult {
  /** Rows in `events_core` with start_time or created_at after the cutoff. */
  count: number;
}

export interface CallbackFailureSeries {
  callbackName: string | null;
  value: number;
}

export interface GatewayProbeResult {
  /** Cumulative callback logging failure counter, summed over callbacks. */
  callbackFailures: CallbackFailureSeries[];
  /** Whether the gateway metrics answer included any request traffic signal. */
  hasMetrics: boolean;
}

export interface TracingProbeClient {
  countEventsCoreSince(
    settings: Pick<TracingHealthSettings, "clickhouseUrl" | "langfuseProjectId">,
    keyValue: string | null,
    sinceMs: number,
  ): Promise<EventsCountResult>;
  readGatewayMetrics(
    settings: Pick<TracingHealthSettings, "litellmMetricsUrl">,
    keyValue: string | null,
  ): Promise<GatewayProbeResult>;
}

export class TracingProbeError extends Error {
  readonly probe: "clickhouse" | "litellm";
  constructor(probe: "clickhouse" | "litellm", message: string) {
    super(message);
    this.name = "TracingProbeError";
    this.probe = probe;
  }
}

/** One line of the Prometheus text format: `name{labels} value`. */
export function parsePrometheusLine(line: string): { name: string; labels: string | null; value: number } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:\s+\d+)?$/.exec(
    trimmed,
  );
  if (!match) return null;
  const value = Number(match[3]);
  if (!Number.isFinite(value)) return null;
  return { name: match[1]!, labels: match[2] ?? null, value };
}

/** The `callback_name` label value of a Prometheus label block, or null. */
export function prometheusLabel(labels: string | null, name: string): string | null {
  if (!labels) return null;
  const inner = labels.slice(1, -1);
  const pattern = new RegExp(`${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = pattern.exec(inner);
  if (!match) return null;
  return match[1]!.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

/** Prometheus output is split on `\n`; a `\r\n` tail is tolerated. */
export function prometheusLines(body: string): string[] {
  return body.split(/\r?\n/);
}

async function fetchText(url: string, keyValue: string | null, probe: "clickhouse" | "litellm"): Promise<string> {
  const headers: Record<string, string> = {};
  if (keyValue) headers.Authorization = `Bearer ${keyValue}`;
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new TracingProbeError(probe, `${probe} probe did not answer: ${err instanceof Error ? err.message : "network error"}`);
  }
  if (!response.ok) {
    throw new TracingProbeError(probe, `${probe} probe answered HTTP ${response.status}`);
  }
  return await response.text();
}

/** One `count()` value from ClickHouse's JSON output, or null for any other shape. */
export function parseClickHouseCount(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const data = (parsed as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length !== 1) return null;
  const row = data[0] as Record<string, unknown> | null;
  if (!row || typeof row !== "object") return null;
  const value = Object.values(row)[0];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function createTracingProbeClient(): TracingProbeClient {
  return {
    async countEventsCoreSince(settings, keyValue, sinceMs) {
      const since = new Date(sinceMs).toISOString().replace("T", " ").slice(0, 19);
      const query = `SELECT count() AS count FROM events_core WHERE (start_time >= '${since}' OR created_at >= '${since}')${settings.langfuseProjectId ? ` AND project_id = '${settings.langfuseProjectId.replace(/'/g, "")}'` : ""} FORMAT JSON`;
      const url = `${settings.clickhouseUrl!.replace(/\/$/, "")}/?default_format=JSON&query=${encodeURIComponent(query)}`;
      const body = await fetchText(url, keyValue, "clickhouse");
      const count = parseClickHouseCount(body);
      if (count === null) {
        throw new TracingProbeError("clickhouse", "clickhouse probe answered in an unexpected shape");
      }
      return { count: Math.max(0, Math.floor(count)) };
    },

    async readGatewayMetrics(settings, keyValue) {
      const body = await fetchText(settings.litellmMetricsUrl!, keyValue, "litellm");
      const failures: CallbackFailureSeries[] = [];
      let hasMetrics = false;
      let sawCallbackMetric = false;
      const byName = new Map<string | null, number>();
      for (const line of prometheusLines(body)) {
        const parsed = parsePrometheusLine(line);
        if (!parsed) continue;
        hasMetrics = true;
        if (parsed.name !== "litellm_callback_logging_failures_metric") continue;
        sawCallbackMetric = true;
        const callbackName = prometheusLabel(parsed.labels, "callback_name");
        byName.set(callbackName, (byName.get(callbackName) ?? 0) + parsed.value);
      }
      for (const [callbackName, value] of byName) {
        if (value !== 0) failures.push({ callbackName, value });
      }
      if (!hasMetrics) {
        throw new TracingProbeError("litellm", "litellm metrics endpoint answered with no metric lines");
      }
      // An endpoint without the callback metric is still a live gateway — the
      // prometheus callback is simply not enabled. That is a configuration
      // gap the card must name, not a silent zero.
      return { callbackFailures: failures, hasMetrics: sawCallbackMetric };
    },
  };
}

