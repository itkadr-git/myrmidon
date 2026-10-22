// myrmidon(1.6.5-PROCS-Q3): the process half of the metrics module. Pins the
// three numbers the multi-process project measures before any scaling
// decision: event loop delay (p50/p99/max, read-and-reset between scrapes),
// RSS/heap gauges, and the live-event flow (count and serialized volume per
// kind). The live-event counters are ordinary subscribers of the existing
// emitter — the suite below publishes through the real service and asserts
// the collector sees exactly what was published, once.

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  publishGlobalLiveEvent,
  publishLiveEvent,
} from "../../../services/live-events.js";
import {
  collectMetricsParts,
  type MetricsCollectorDeps,
} from "./metrics.js";
import {
  defaultProcessMetricsSource,
  disableEventLoopMonitor,
  disablePulseEventLoopMonitor,
  enableEventLoopMonitor,
  enablePulseEventLoopMonitor,
  eventLoopUtilizationSupported,
  liveEventCountersSnapshot,
  readEventLoopSample,
  readEventLoopUtilizationSample,
  readMemorySample,
  readProcessMetrics,
  readPulseEventLoopLagMs,
  recordLiveEvent,
  resetProcessMetricsState,
  resolveProcessMetricsSource,
  startProcessMetricsObservation,
  type ProcessMetricsSource,
} from "./process-metrics.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");

function baseDeps(overrides: Partial<MetricsCollectorDeps> = {}): MetricsCollectorDeps {
  return {
    db: {
      // A DB that throws on every read: the process half must still collect,
      // and the failure must not crash the scrape.
      select: () => {
        throw new Error("database unavailable");
      },
    } as never,
    now: () => NOW,
    errorWindowSec: 3600,
    latencyWindowSec: 3600,
    ...overrides,
  };
}

describe("process metrics: live-event counters", () => {
  afterEach(() => {
    resetProcessMetricsState();
  });

  it("counts one per kind and accumulates serialized payload bytes", () => {
    recordLiveEvent({ type: "agent.status", payload: { ok: 1 } });
    recordLiveEvent({ type: "agent.status", payload: { ok: 22 } });
    recordLiveEvent({ type: "heartbeat.run.status", payload: {} });

    const rows = liveEventCountersSnapshot();
    expect(rows.map((row) => row.type)).toEqual([
      "agent.status",
      "heartbeat.run.status",
    ]);
    expect(rows[0]).toEqual({
      type: "agent.status",
      count: 2,
      bytes:
        Buffer.byteLength(JSON.stringify({ ok: 1 })) +
        Buffer.byteLength(JSON.stringify({ ok: 22 })),
    });
    expect(rows[1].count).toBe(1);
    expect(rows[1].bytes).toBe(2);
  });

  it("counts an empty/undefined payload as zero bytes but still one event", () => {
    recordLiveEvent({ type: "activity.logged", payload: undefined });
    recordLiveEvent({ type: "external_object.updated", payload: null });
    const rows = liveEventCountersSnapshot();
    expect(rows.find((r) => r.type === "activity.logged")).toEqual({
      type: "activity.logged",
      count: 1,
      bytes: 0,
    });
    expect(rows.find((r) => r.type === "external_object.updated")).toEqual({
      type: "external_object.updated",
      count: 1,
      bytes: 0,
    });
  });

  it("never throws — a circular payload is counted with zero volume", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      recordLiveEvent({ type: "plugin.ui.updated", payload: circular as never }),
    ).not.toThrow();
    expect(liveEventCountersSnapshot()).toEqual([{ type: "plugin.ui.updated", count: 1, bytes: 0 }]);
  });

  it("observes the real emitter once per published event (no double counting)", () => {
    const stop = startProcessMetricsObservation();
    try {
      publishLiveEvent({ companyId: "company-a", type: "agent.status", payload: { n: 1 } });
      publishGlobalLiveEvent({ type: "heartbeat.run.status", payload: { n: 22 } });
      const rows = liveEventCountersSnapshot();
      // Company event → allCompanyEvents stream exactly once; global event →
      // the "*" stream exactly once. Neither listener double-counts.
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.type === "agent.status")?.count).toBe(1);
      expect(rows.find((r) => r.type === "heartbeat.run.status")?.count).toBe(1);
      expect(
        (rows.find((r) => r.type === "heartbeat.run.status")?.bytes ?? 0) > 0,
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it("start is idempotent: two starts still count one event once", () => {
    const stopA = startProcessMetricsObservation();
    const stopB = startProcessMetricsObservation();
    try {
      publishLiveEvent({ companyId: "company-b", type: "activity.logged", payload: {} });
      expect(liveEventCountersSnapshot().find((r) => r.type === "activity.logged")?.count).toBe(1);
    } finally {
      stopA();
      stopB();
    }
  });
});

describe("process metrics: event loop delay", () => {
  // The live-event suite above enables the monitor via startProcessMetricsObservation
  // (stop() only unwires the subscribers); the delay tests own the switch.
  beforeEach(() => {
    disableEventLoopMonitor();
  });
  afterEach(() => {
    disableEventLoopMonitor();
  });

  it("reads null before the monitor is enabled", () => {
    expect(readEventLoopSample()).toBe(null);
  });

  it("reads p50/p99/max in seconds after enabling", async () => {
    enableEventLoopMonitor();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Block the loop once so the histogram has a real lag sample: an
    // empty/instant window can report max=0 while percentiles land on the
    // first resolution bucket, which made the ordering asserts flaky.
    const start = Date.now();
    while (Date.now() - start < 40) {
      /* spin */
    }
    const sample = readEventLoopSample();
    expect(sample).not.toBe(null);
    expect(sample!.p50Seconds).toBeGreaterThanOrEqual(0);
    expect(sample!.p99Seconds).toBeGreaterThanOrEqual(sample!.p50Seconds);
    expect(sample!.maxSeconds).toBeGreaterThanOrEqual(sample!.p99Seconds);
    // Seconds-scale stays sane — the histogram counts real lag in seconds.
    expect(sample!.maxSeconds).toBeLessThan(1);
  });

  it("is read-and-reset: a fresh window follows every read", () => {
    enableEventLoopMonitor();
    const first = readEventLoopSample();
    const second = readEventLoopSample();
    expect(first).not.toBe(second);
    expect(second!.maxSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("process metrics: event loop utilization (1.6.6 PROCS-0.1)", () => {
  afterEach(() => {
    resetProcessMetricsState();
  });

  it("reports the API as available on a runtime that has it", () => {
    expect(eventLoopUtilizationSupported()).toBe(true);
  });

  it("reads a 0..1 window ratio and opens a fresh window on every read", () => {
    const first = readEventLoopUtilizationSample();
    expect(first).not.toBe(null);
    expect(first!.utilization).toBeGreaterThanOrEqual(0);
    expect(first!.utilization).toBeLessThanOrEqual(1);
    const second = readEventLoopUtilizationSample();
    expect(second).not.toBe(null);
    expect(second!.utilization).toBeGreaterThanOrEqual(0);
    expect(second!.utilization).toBeLessThanOrEqual(1);
  });

  it("rides the process read the metrics exposition uses", () => {
    expect(readProcessMetrics()).toHaveProperty("eventLoopUtilization.utilization");
  });
});

describe("process metrics: the pulse histogram of the registry", () => {
  afterEach(() => {
    disablePulseEventLoopMonitor();
  });

  it("reads null while the pulse monitor is off", () => {
    disablePulseEventLoopMonitor();
    expect(readPulseEventLoopLagMs()).toBe(null);
  });

  it("reads and resets its own window without consuming the scrape histogram", async () => {
    enableEventLoopMonitor();
    enablePulseEventLoopMonitor();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const lagMs = readPulseEventLoopLagMs();
      expect(lagMs).not.toBe(null);
      expect(lagMs!).toBeGreaterThanOrEqual(0);
      // Two consumers, two windows: the 10 s pulse must not shorten what
      // myrmidon_board_event_loop_lag_seconds describes at scrape time.
      expect(readEventLoopSample()).not.toBe(null);
      expect(readPulseEventLoopLagMs()).not.toBe(null);
    } finally {
      disableEventLoopMonitor();
    }
  });
});

describe("process metrics: memory gauges", () => {
  it("reports RSS/heap of this process in positive bytes", () => {
    const memory = readMemorySample();
    expect(memory.rssBytes).toBeGreaterThan(0);
    expect(memory.heapUsedBytes).toBeGreaterThan(0);
    expect(memory.heapTotalBytes).toBeGreaterThanOrEqual(memory.heapUsedBytes);
  });
});

describe("process metrics: the source seam", () => {
  afterEach(() => {
    resetProcessMetricsState();
    disableEventLoopMonitor();
  });

  it("accepts function and object forms", () => {
    const sample = {
      eventLoop: null,
      eventLoopUtilization: null,
      memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 2 },
      liveEvents: [],
    };
    expect(resolveProcessMetricsSource(() => sample)()).toBe(sample);
    expect(resolveProcessMetricsSource({ read: () => sample })()).toBe(sample);
    // Absent → the production default (the live read of this process).
    const live = resolveProcessMetricsSource(undefined)();
    expect(live.memory.rssBytes).toBeGreaterThan(0);
    const asObject: ProcessMetricsSource = defaultProcessMetricsSource;
    expect(asObject).toBeInstanceOf(Object);
    expect(readProcessMetrics().memory.heapTotalBytes).toBeGreaterThan(0);
  });

  it("a throwing process source names the six families and keeps the scrape alive", async () => {
    const collected = await collectMetricsParts(
      baseDeps({
        processMetrics: () => {
          throw new Error("histogram unavailable");
        },
      }),
    );
    const boardFamilies = collected.errors
      .flatMap((entry) => entry.split("|"))
      .filter((family) => family.startsWith("myrmidon_board_"));
    expect(boardFamilies).toHaveLength(6);
    expect(collected.fields.process).toBe(null);
    // The DB half still failed independently — and nothing crashed.
    expect(collected.errors.length).toBeGreaterThan(5);
  });

  it("the collector wires the injected fake into the snapshot", async () => {
    const sample = {
      eventLoop: { p50Seconds: 0.01, p99Seconds: 0.02, maxSeconds: 0.5 },
      eventLoopUtilization: { utilization: 0.25 },
      memory: { rssBytes: 1000, heapUsedBytes: 500, heapTotalBytes: 800 },
      liveEvents: [{ type: "agent_status", count: 3, bytes: 90 }],
    };
    const collected = await collectMetricsParts(baseDeps({ processMetrics: () => sample }));
    expect(collected.fields.process).toEqual(sample);
    expect(
      collected.errors.some((entry) => entry.includes("myrmidon_board_")),
    ).toBe(false);
  });
});
