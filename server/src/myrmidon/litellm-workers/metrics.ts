// server/src/myrmidon/litellm-workers/metrics.ts
//
// myrmidon(1.6.5 LITELLM-WORKERS A): the arithmetic behind the three live
// numbers the workers endpoint reports, read from the gateway's own Prometheus
// exposition (`GET /metrics`).
//
// No HTTP and no clock live here: the caller hands in the scraped body and the
// elapsed time between two scrapes, so every rule below is testable without a
// gateway. Where a family is absent the reader answers null instead of a
// plausible-looking zero — an operator must be able to tell "no answer" from
// "no load".
//
// The families are read by name, and the names are the ones a LiteLLM proxy
// exposes: `litellm_in_flight_requests` for the queue, a request-latency
// histogram for the answer time, and prometheus_client's per-process CPU
// counter for the load. A gateway that exports none of them still resizes
// correctly; only the reported numbers fall back to null.

import type { LitellmWorkersMetrics } from "@paperclipai/shared";

/** One sample of the exposition: a family name, its labels and its value. */
export interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** The histogram family the median answer time is read from. */
export const LITELLM_LATENCY_HISTOGRAM = "litellm_request_total_latency_metric";

/** The gauge holding requests accepted but not answered yet. */
export const LITELLM_IN_FLIGHT_GAUGE = "litellm_in_flight_requests";

/** The per-process CPU counter prometheus_client exports per worker. */
export const PROCESS_CPU_COUNTER = "process_cpu_seconds_total";

const LABEL_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  LABEL_PATTERN.lastIndex = 0;
  let match = LABEL_PATTERN.exec(text);
  while (match !== null) {
    labels[match[1]!] = match[2]!;
    match = LABEL_PATTERN.exec(text);
  }
  return labels;
}

/**
 * The whole exposition as samples.
 *
 * Only the plain text format is read: comments and blanks are skipped, a line
 * whose value does not parse is dropped, and a label value is taken as written
 * (the escapes prometheus defines are left as-is — no family read below carries
 * a value an escape would change).
 */
export function parsePrometheusText(text: string): PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const spaceAt = line.lastIndexOf(" ");
    if (spaceAt <= 0) continue;
    const left = line.slice(0, spaceAt).trim();
    const value = Number(line.slice(spaceAt + 1).trim());
    if (!left || !Number.isFinite(value)) continue;
    const braceAt = left.indexOf("{");
    if (braceAt === -1) {
      samples.push({ name: left, labels: {}, value });
      continue;
    }
    const closeAt = left.lastIndexOf("}");
    if (closeAt < braceAt) continue;
    samples.push({ name: left.slice(0, braceAt).trim(), labels: parseLabels(left.slice(braceAt + 1, closeAt)), value });
  }
  return samples;
}

function sumOf(samples: readonly PrometheusSample[], names: readonly string[]): number | null {
  const matching = samples.filter((sample) => names.includes(sample.name));
  if (matching.length === 0) return null;
  return matching.reduce((total, sample) => total + sample.value, 0);
}

/**
 * How many worker processes the gateway runs, when it says so outright.
 *
 * The families below are the ones a proxy in gunicorn mode publishes for its
 * pool. They are the only trustworthy source: a scrape reaches ONE worker
 * unless prometheus_client runs in multiprocess mode, so a per-pid count is a
 * hint about the worker that answered, not the size of the pool — which is why
 * it is read separately and used last.
 */
export function readPrometheusWorkerGauge(samples: readonly PrometheusSample[]): number | null {
  const gauges = sumOf(samples, ["litellm_workers", "litellm_proxy_workers", "gunicorn_workers"]);
  if (gauges === null) return null;
  return Math.max(0, Math.round(gauges));
}

/**
 * The number of distinct pids in the exposition — the LEAST trustworthy count
 * of the pool, because one scrape normally reaches a single worker. Read only
 * when nothing else knows the size, and reported as such.
 */
export function readPrometheusWorkerPidCount(samples: readonly PrometheusSample[]): number | null {
  const pids = new Set<string>();
  for (const sample of samples) {
    if (sample.name !== PROCESS_CPU_COUNTER) continue;
    const pid = sample.labels.pid;
    if (typeof pid === "string" && pid) pids.add(pid);
  }
  return pids.size > 0 ? pids.size : null;
}

/** Requests accepted but not answered yet; summed over the pool. */
export function readPrometheusQueueDepth(samples: readonly PrometheusSample[]): number | null {
  const depth = sumOf(samples, [LITELLM_IN_FLIGHT_GAUGE, `${LITELLM_IN_FLIGHT_GAUGE}_total`]);
  if (depth === null) return null;
  return Math.max(0, depth);
}

function histogramBounds(samples: readonly PrometheusSample[]): Map<number, number> {
  const byBound = new Map<number, number>();
  for (const sample of samples) {
    if (sample.name !== `${LITELLM_LATENCY_HISTOGRAM}_bucket`) continue;
    const rawBound = sample.labels.le;
    if (typeof rawBound !== "string") continue;
    const bound = rawBound === "+Inf" ? Number.POSITIVE_INFINITY : Number(rawBound);
    if (Number.isNaN(bound)) continue;
    byBound.set(bound, (byBound.get(bound) ?? 0) + sample.value);
  }
  return byBound;
}

/**
 * The median answer time, in milliseconds, interpolated inside the bucket the
 * median falls into. A histogram is what makes a median answerable at all —
 * a summary exposes a sum and a count, i.e. a mean, and a mean is not reported
 * here under the name of a median.
 */
export function readPrometheusMedianLatencyMs(samples: readonly PrometheusSample[]): number | null {
  const byBound = histogramBounds(samples);
  if (byBound.size === 0) return null;
  const bounds = [...byBound.keys()].sort((left, right) => left - right);
  const total = byBound.get(bounds[bounds.length - 1]!) ?? 0;
  if (!(total > 0)) return null;
  const half = total / 2;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const bound of bounds) {
    const count = byBound.get(bound)!;
    if (count >= half) {
      const upper = Number.isFinite(bound) ? bound : lowerBound;
      const inBucket = count - lowerCount;
      const fraction = inBucket > 0 ? (half - lowerCount) / inBucket : 0;
      return Math.max(0, Math.round((lowerBound + (upper - lowerBound) * fraction) * 1000));
    }
    if (Number.isFinite(bound)) lowerBound = bound;
    lowerCount = count;
  }
  return null;
}

/** One worker's CPU seconds, keyed by the pid that reports them. */
export function readPrometheusCpuSamples(samples: readonly PrometheusSample[]): Map<string, number> {
  const byPid = new Map<string, number>();
  for (const sample of samples) {
    if (sample.name !== PROCESS_CPU_COUNTER) continue;
    const pid = sample.labels.pid;
    if (typeof pid !== "string" || !pid) continue;
    byPid.set(pid, (byPid.get(pid) ?? 0) + sample.value);
  }
  return byPid;
}

/**
 * The mean CPU fraction of one worker between two scrapes: the CPU seconds
 * each worker burned divided by the wall time that passed, averaged over the
 * workers both scrapes saw. The first scrape answers null — a counter without
 * a previous reading is a total, not a rate — and so does an elapsed time that
 * is not positive.
 */
export function derivePerWorkerCpu(
  previous: ReadonlyMap<string, number> | null,
  current: ReadonlyMap<string, number>,
  elapsedSec: number,
): number | null {
  if (previous === null || !(elapsedSec > 0) || current.size === 0) return null;
  const fractions: number[] = [];
  for (const [pid, total] of current) {
    const before = previous.get(pid);
    if (before === undefined) continue;
    const delta = total - before;
    // A counter that went backwards means the worker was replaced; its rate
    // over the whole window is not something this sample can state.
    if (!(delta >= 0)) continue;
    fractions.push(delta / elapsedSec);
  }
  if (fractions.length === 0) return null;
  const mean = fractions.reduce((total, value) => total + value, 0) / fractions.length;
  return Math.round(mean * 10000) / 10000;
}

/** The three reported numbers, null for every family the gateway does not carry. */
export function readPrometheusMetrics(samples: readonly PrometheusSample[], perWorkerCpu: number | null): LitellmWorkersMetrics {
  return {
    perWorkerCpu,
    medianLatencyMs: readPrometheusMedianLatencyMs(samples),
    queueDepth: readPrometheusQueueDepth(samples),
  };
}

/** The numbers of a gateway that could not be read. */
export function unavailableLitellmWorkersMetrics(): LitellmWorkersMetrics {
  return { perWorkerCpu: null, medianLatencyMs: null, queueDepth: null };
}

/**
 * Remembers the last scrape so the next one can turn the CPU counter into a
 * rate. One sampler per gateway, held by the module that owns it — never a
 * module-level variable, so two gateways cannot average into each other.
 */
export class LitellmWorkerCpuSampler {
  private previous: { atMs: number; samples: Map<string, number> } | null = null;

  /** Feeds one scrape and answers the mean per-worker CPU fraction, or null. */
  observe(samples: Map<string, number>, atMs: number): number | null {
    const before = this.previous;
    this.previous = { atMs, samples };
    if (before === null) return null;
    return derivePerWorkerCpu(before.samples, samples, (atMs - before.atMs) / 1000);
  }
}