// server/src/myrmidon/monitoring/metrics/process-metrics.ts
//
// myrmidon(1.6.5-PROCS-Q3): the process metrics of the board — event loop
// delay (p50/p99/max), memory (RSS/heap), and the live-event flow (kind and
// volume). T0.1 of the multi-process project (design §1, этап 0): the
// measurement precedes any scaling decision.
//
// Everything here is in-process state: no DB, no store, no migration, no new
// settings, nothing mounted. The event loop delay comes from
// `monitorEventLoopDelay` and is READ-AND-RESET — the quantiles describe the
// interval between scrapes, which is exactly what an alerting window
// consumes; Node keeps the histogram timer unref-ed, so the monitor never
// holds the process open. Live-event counters attach to the existing
// `services/live-events.ts` emitters as ordinary subscribers: the publisher
// itself is NOT modified, and a per-event listener that bumps a Map entry
// costs nanoseconds (the overhead measurement lives in the PR: < 1 % CPU).
//
// The whole thing is a seam: the collector takes a `ProcessMetricsSource`,
// tests inject fakes, production wires `defaultProcessMetricsSource`.

import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  subscribeAllCompanyLiveEvents,
  subscribeGlobalLiveEvents,
} from "../../../services/live-events.js";
import type { LiveEvent } from "@paperclipai/shared";

export type ProcessEventLoopSample = {
  p50Seconds: number;
  p99Seconds: number;
  maxSeconds: number;
};

/** Event-loop utilization of a window: the share of the window the loop was
 * busy, 0..1, from `performance.eventLoopUtilization`. */
export type ProcessEventLoopUtilizationSample = {
  utilization: number;
};

export type ProcessMemorySample = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
};

export type ProcessLiveEventSample = {
  type: string;
  count: number;
  bytes: number;
};

export type ProcessMetricsSample = {
  /** null while the histogram is not enabled. */
  eventLoop: ProcessEventLoopSample | null;
  /** null when the runtime has no eventLoopUtilization (Node < 16.14). */
  eventLoopUtilization: ProcessEventLoopUtilizationSample | null;
  memory: ProcessMemorySample;
  /** Per-type counters since boot, sorted by type for a stable exposition. */
  liveEvents: ProcessLiveEventSample[];
};

/** Function form (the collector injects it) or object form (symmetry with
 * the other metrics ports) — both accepted. */
export type ProcessMetricsSource =
  | (() => ProcessMetricsSample)
  | { read: () => ProcessMetricsSample };

const NANOSECONDS_PER_SECOND = 1_000_000_000;
const DEFAULT_HISTOGRAM_RESOLUTION_MS = 20;

let loopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
// Second histogram, owned by the process registry's pulse: reusing
// loopHistogram would make a 10 s pulse reset the scrape window and quietly
// change what myrmidon_board_event_loop_lag_seconds describes.
let pulseHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
// Previous eventLoopUtilization reading: the gauge reports the delta against
// it, so the family describes a window like every other family does.
let utilizationBaseline: ReturnType<typeof performance.eventLoopUtilization> | null = null;
let observationStarted = false;
const liveEventCounters = new Map<string, { count: number; bytes: number }>();

/** One listener per published event: one counter per type plus serialized
 * payload bytes. O(1) and never throws — a metrics listener must not be able
 * to break a publish. */
export function recordLiveEvent(event: {
  type: LiveEvent["type"];
  payload?: unknown;
}): void {
  try {
    let entry = liveEventCounters.get(event.type);
    if (!entry) {
      entry = { count: 0, bytes: 0 };
      liveEventCounters.set(event.type, entry);
    }
    entry.count += 1;
    entry.bytes += serializedPayloadBytes(event.payload);
  } catch {
    // Metrics never break a publish.
  }
}

function serializedPayloadBytes(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(payload));
  } catch {
    // A non-serializable payload still counts as an event; its volume is 0.
    return 0;
  }
}

export function liveEventCountersSnapshot(): ProcessLiveEventSample[] {
  return [...liveEventCounters.entries()]
    .map(([type, entry]) => ({ type, count: entry.count, bytes: entry.bytes }))
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/** Enables the delay histogram once (idempotent). */
export function enableEventLoopMonitor(resolutionMs: number = DEFAULT_HISTOGRAM_RESOLUTION_MS): void {
  if (loopHistogram) return;
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  loopHistogram = histogram;
}

/** Releases the histogram (test seam; production keeps it for process life). */
export function disableEventLoopMonitor(): void {
  loopHistogram?.disable();
  loopHistogram = null;
}

/** Enables the pulse histogram once (idempotent). It is deliberately separate
 * from the scrape histogram: the process registry's pulse reads and resets it
 * every 10 s. */
export function enablePulseEventLoopMonitor(
  resolutionMs: number = DEFAULT_HISTOGRAM_RESOLUTION_MS,
): void {
  if (pulseHistogram) return;
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  pulseHistogram = histogram;
}

/** Releases the pulse histogram (test seam). */
export function disablePulseEventLoopMonitor(): void {
  pulseHistogram?.disable();
  pulseHistogram = null;
}

/** p50 of the pulse window in milliseconds, read-and-reset, so what the
 * process registry stores describes the interval since the previous pulse.
 * null while the pulse monitor is off. */
export function readPulseEventLoopLagMs(): number | null {
  if (!pulseHistogram) return null;
  const lagMs = pulseHistogram.percentile(50) / 1_000_000;
  pulseHistogram.reset();
  return lagMs;
}

/** `perf_hooks.performance.eventLoopUtilization` exists on Node >= 16.14. */
export function eventLoopUtilizationSupported(): boolean {
  return typeof performance.eventLoopUtilization === "function";
}

/** Utilization of the interval since the previous read — read-and-reset, like
 * the delay histogram, so the gauge describes a window rather than the whole
 * process life. The first read of a process describes the interval since it
 * started. null when the runtime has no such API. */
export function readEventLoopUtilizationSample(): ProcessEventLoopUtilizationSample | null {
  if (!eventLoopUtilizationSupported()) return null;
  const current = performance.eventLoopUtilization();
  const previous = utilizationBaseline;
  utilizationBaseline = current;
  const window = previous ? performance.eventLoopUtilization(current, previous) : current;
  return { utilization: window.utilization };
}

/** Reads p50/p99/max in seconds and resets the window — the quantiles
 * describe the interval since the previous read (scrape). null while the
 * monitor is not enabled. */
export function readEventLoopSample(): ProcessEventLoopSample | null {
  if (!loopHistogram) return null;
  const sample = {
    p50Seconds: loopHistogram.percentile(50) / NANOSECONDS_PER_SECOND,
    p99Seconds: loopHistogram.percentile(99) / NANOSECONDS_PER_SECOND,
    maxSeconds: loopHistogram.max / NANOSECONDS_PER_SECOND,
  };
  loopHistogram.reset();
  return sample;
}

/** RSS and V8 heap of this process, in bytes. */
export function readMemorySample(): ProcessMemorySample {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
  };
}

/**
 * Turns the observers on for this process (idempotent): the delay histogram
 * plus the live-event subscribers. The routes start it lazily on the first
 * authenticated scrape, so the only switch stays the existing metrics
 * enablement — no new settings, no restart behaviour change. Returns the
 * unsubscribe pair for tests; production never calls it back.
 */
export function startProcessMetricsObservation(): () => void {
  if (observationStarted) return () => {};
  observationStarted = true;
  enableEventLoopMonitor();
  const offCompany = subscribeAllCompanyLiveEvents((event) => recordLiveEvent(event));
  const offGlobal = subscribeGlobalLiveEvents((event) => recordLiveEvent(event));
  return () => {
    offCompany();
    offGlobal();
    observationStarted = false;
  };
}

export function readProcessMetrics(): ProcessMetricsSample {
  return {
    eventLoop: readEventLoopSample(),
    eventLoopUtilization: readEventLoopUtilizationSample(),
    memory: readMemorySample(),
    liveEvents: liveEventCountersSnapshot(),
  };
}

export const defaultProcessMetricsSource: ProcessMetricsSource = { read: readProcessMetrics };

export function resolveProcessMetricsSource(
  source?: ProcessMetricsSource | null,
): () => ProcessMetricsSample {
  if (!source) return readProcessMetrics;
  return typeof source === "function" ? source : () => source.read();
}

/** Test seam: drops every counter (production never calls it). */
export function resetProcessMetricsState(): void {
  liveEventCounters.clear();
  utilizationBaseline = null;
  disablePulseEventLoopMonitor();
}
