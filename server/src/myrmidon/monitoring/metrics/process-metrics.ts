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
//
// myrmidon(1.6.5-PROCS-T02): the same seam carries the lane counters of T0.2 —
// per lane, the DB queries issued and the busy seconds its work occupied. They
// are plain in-process counters too (no DB, no timers, no new settings), fed by
// lane-metrics.ts; the DB side reaches this module through the observer seam of
// packages/db/src/myrmidon-query-accounting.ts. Every lane listener is
// total: a counter that throws would break the work it measures.

import { monitorEventLoopDelay } from "node:perf_hooks";
import { UNLABELED_LANE } from "./lane-context.js";
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

export type ProcessLaneSample = {
  lane: string;
  /** DB queries this lane issued since boot. */
  queries: number;
  /** Wall time the labelled sections of this lane occupied, in seconds. */
  busySeconds: number;
};

export type ProcessMetricsSample = {
  /** null while the histogram is not enabled. */
  eventLoop: ProcessEventLoopSample | null;
  memory: ProcessMemorySample;
  /** Per-type counters since boot, sorted by type for a stable exposition. */
  liveEvents: ProcessLiveEventSample[];
  /** Per-lane counters since boot, sorted by lane for a stable exposition. */
  lanes: ProcessLaneSample[];
};

/** Function form (the collector injects it) or object form (symmetry with
 * the other metrics ports) — both accepted. */
export type ProcessMetricsSource =
  | (() => ProcessMetricsSample)
  | { read: () => ProcessMetricsSample };

const NANOSECONDS_PER_SECOND = 1_000_000_000;
const DEFAULT_HISTOGRAM_RESOLUTION_MS = 20;

let loopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let observationStarted = false;
const liveEventCounters = new Map<string, { count: number; bytes: number }>();
const laneCounters = new Map<string, { queries: number; busySeconds: number }>();

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

function laneEntry(lane: string): { queries: number; busySeconds: number } {
  const label = lane.trim() === "" ? UNLABELED_LANE : lane.trim();
  let entry = laneCounters.get(label);
  if (!entry) {
    entry = { queries: 0, busySeconds: 0 };
    laneCounters.set(label, entry);
  }
  return entry;
}

/** One query issued by the lane running now (or by "unlabeled" work). Never
 * throws: a metrics listener must not be able to break a query. */
export function recordLaneQuery(lane: string): void {
  try {
    laneEntry(lane).queries += 1;
  } catch {
    // Metrics never break a query.
  }
}

/** Adds the wall time a labelled section of `lane` occupied. Non-finite and
 * negative readings are ignored, not clamped into the series. Never throws. */
export function recordLaneBusySeconds(lane: string, seconds: number): void {
  try {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    laneEntry(lane).busySeconds += seconds;
  } catch {
    // Metrics never break the work they measure.
  }
}

export function laneCountersSnapshot(): ProcessLaneSample[] {
  return [...laneCounters.entries()]
    .map(([lane, entry]) => ({
      lane,
      queries: entry.queries,
      busySeconds: entry.busySeconds,
    }))
    .sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
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
    memory: readMemorySample(),
    liveEvents: liveEventCountersSnapshot(),
    lanes: laneCountersSnapshot(),
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
  laneCounters.clear();
}
