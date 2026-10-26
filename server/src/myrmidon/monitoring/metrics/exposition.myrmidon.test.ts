// myrmidon(1.7-METRICS): the exposition-format contract. Every family the
// ticket names must be present with exactly one HELP and one TYPE line, the
// samples must be parseable values, and the text must end with a newline.

import { describe, expect, it } from "vitest";
import {
  METRIC_FAMILIES,
  escapeLabelValue,
  formatSampleValue,
  percentile,
  renderMetricsText,
  type MetricsSnapshot,
} from "./metrics.js";
import { continuationDedupeMetrics } from "../../../services/continuation-dedupe-metrics.js";

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    role: "all",
    runsActive: 2,
    runsQueued: 5,
    deferredIssueExecutionOver30m: 0,
    runsFailedTotal: 7,
    runsFailedWindow: 1,
    runDurationSecondsP50: 42.5,
    runDurationSecondsP95: 130.25,
    roleQueueTasks: [
      { role: "engineer", status: "todo", count: 3 },
      { role: "engineer", status: "in_progress", count: 1 },
      { role: "reviewer", status: "in_review", count: 2 },
    ],
    swarmClaimsActive: 4,
    swarmClaimsTotal: 12,
    agentErrorSignals: 1,
    llmCostCentsWindow: 1234,
    process: {
      eventLoop: { p50Seconds: 0.02, p99Seconds: 0.13, maxSeconds: 0.5 },
      eventLoopUtilization: { utilization: 0.42 },
      memory: { rssBytes: 500000000, heapUsedBytes: 120000000, heapTotalBytes: 200000000 },
      liveEvents: [
        { type: "agent_status", count: 7, bytes: 1024 },
        { type: "run_finished", count: 3, bytes: 512 },
      ],
    },
    scrapeErrors: 0,
    collectedAt: "2026-10-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("prometheus exposition format", () => {
  it("renders every family the ticket names", () => {
    const text = renderMetricsText(snapshot());
    for (const family of METRIC_FAMILIES) {
      expect(text, `family ${family} must appear`).toContain(family);
    }
  });

  it("renders the created and deduped continuation counters after port calls", () => {
    continuationDedupeMetrics.reset();
    try {
      continuationDedupeMetrics.metrics.onContinuationCreated("created-key");
      continuationDedupeMetrics.metrics.onContinuationCreated("another-created-key");
      continuationDedupeMetrics.metrics.onContinuationDeduped("deduped-key");

      const text = renderMetricsText(snapshot());
      expect(text).toContain("# TYPE myrmidon_continuation_created_total counter");
      expect(text).toContain('myrmidon_continuation_created_total{role="all"} 2');
      expect(text).toContain("# TYPE myrmidon_continuation_deduped_total counter");
      expect(text).toContain('myrmidon_continuation_deduped_total{role="all"} 1');
    } finally {
      continuationDedupeMetrics.reset();
    }
  });

  it("renders exactly one HELP and one TYPE line per family", () => {
    const text = renderMetricsText(snapshot());
    const lines = text.split("\n");
    for (const family of METRIC_FAMILIES) {
      const helpLines = lines.filter((line) => line.startsWith(`# HELP ${family} `));
      const typeLines = lines.filter((line) => line.startsWith(`# TYPE ${family} `));
      expect(helpLines, `${family} HELP`).toHaveLength(1);
      expect(typeLines, `${family} TYPE`).toHaveLength(1);
    }
  });

  it("declares the expected TYPE per family", () => {
    const text = renderMetricsText(snapshot());
    expect(text).toContain("# TYPE myrmidon_runs_active gauge");
    expect(text).toContain("# TYPE myrmidon_runs_queued gauge");
    expect(text).toContain("# TYPE myrmidon_deferred_issue_execution_over_30m gauge");
    expect(text).toContain("# TYPE myrmidon_runs_failed_total gauge");
    expect(text).toContain("# TYPE myrmidon_runs_failed_window gauge");
    expect(text).toContain("# TYPE myrmidon_run_duration_seconds summary");
    expect(text).toContain("# TYPE myrmidon_role_queue_tasks gauge");
    expect(text).toContain("# TYPE myrmidon_swarm_claims_active gauge");
    expect(text).toContain("# TYPE myrmidon_swarm_claims_total counter");
    expect(text).toContain("# TYPE myrmidon_agent_error_signals gauge");
    expect(text).toContain("# TYPE myrmidon_llm_cost_cents_total counter");
    expect(text).toContain("# TYPE myrmidon_scrape_errors gauge");
    expect(text).toContain("# TYPE myrmidon_board_event_loop_utilization gauge");
  });

  it("renders deferred issue-execution backlog gauge", () => {
    const text = renderMetricsText(snapshot({ deferredIssueExecutionOver30m: 2 }));
    expect(text).toContain('myrmidon_deferred_issue_execution_over_30m{role="all"} 2');
  });

  it("renders one sample line per family and per role/status pair", () => {
    const text = renderMetricsText(snapshot());
    const sampleLines = text.split("\n").filter((line) => line.startsWith("myrmidon_"));
    // 10 single-sample families + 2 quantile samples + 3 role pairs = 15,
    // plus the process half (1.6.5-PROCS-Q3): 3 loop quantiles + 1 RSS +
    // 2 heap kinds + 2 live-event counters + 2 live-event byte counters = 10,
    // plus the utilization gauge (1.6.6 PROCS-0.1) = 25, plus the two
    // continuation dedupe counters = 27, plus deferredIssueExecutionOver30m = 28.
    expect(sampleLines).toHaveLength(28);
    expect(text).toContain('myrmidon_role_queue_tasks{role="all",assignee_role="engineer",status="todo"} 3');
    expect(text).toContain('myrmidon_role_queue_tasks{role="all",assignee_role="reviewer",status="in_review"} 2');
    expect(text).toContain('myrmidon_board_event_loop_lag_seconds{role="all",quantile="0.99"} 0.13');
    expect(text).toContain("myrmidon_board_event_loop_utilization{role=\"all\"} 0.42");
    expect(text).toContain('myrmidon_board_heap_bytes{role="all",kind="used"} 120000000');
    expect(text).toContain('myrmidon_board_live_events_total{role="all",kind="run_finished"} 3');
  });

  // myrmidon(1.6.6 OPE-6959): every sample carries the process role label —
  // the metric names stay, the label set grows. A worker scrape renders
  // role="worker" on every family, the api processes role="api".
  it("stamps the snapshot role on every sample", () => {
    const text = renderMetricsText(
      snapshot({
        role: "worker",
        lanes: [{ lane: "heartbeat_tick", dbQueries: 5, busyMs: 10, executions: 2 }],
      }),
    );
    const sampleLines = text.split("\n").filter((line) => line.startsWith("myrmidon_"));
    expect(sampleLines.length).toBeGreaterThan(0);
    for (const line of sampleLines) {
      expect(line, `sample must carry role: ${line}`).toContain('role="worker"');
    }
    expect(text).toContain("myrmidon_runs_active{role=\"worker\"} 2");
    expect(text).toContain('myrmidon_board_db_queries_total{role="worker",lane="heartbeat_tick"} 5');
    // Metric names are untouched by the role label.
    expect(text).toContain("# HELP myrmidon_runs_active ");
  });

  // myrmidon(1.6.6 PROCS-0.3A): the load lanes ride the same scrape, so the
  // exposition must show a sample per lane when the lanes were read, and the
  // two families (with HELP/TYPE, no samples) when the collector has none.
  it("renders one sample per lane for both lane families", () => {
    const text = renderMetricsText(
      snapshot({
        lanes: [
          { lane: "http_route", dbQueries: 12, busyMs: 34.5, executions: 7 },
          { lane: "heartbeat_tick", dbQueries: 0, busyMs: 0, executions: 0 },
        ],
      }),
    );

    expect(text).toContain('myrmidon_board_db_queries_total{role="all",lane="http_route"} 12');
    expect(text).toContain('myrmidon_board_db_queries_total{role="all",lane="heartbeat_tick"} 0');
    expect(text).toContain('myrmidon_board_lane_busy_seconds_total{role="all",lane="http_route"} 0.0345');
    expect(text).toContain('myrmidon_board_lane_busy_seconds_total{role="all",lane="heartbeat_tick"} 0');
  });

  // myrmidon(1.6.6 PROCS-1.5 / OPE-5412): the single-route proxy counter renders
  // every route x outcome, zeros included, with the process role label; without
  // a read it keeps HELP/TYPE and no samples.
  it("renders the singleton proxy family with every route and outcome", () => {
    const text = renderMetricsText(
      snapshot({
        role: "api",
        singletonProxy: [
          { route: "attention", outcome: "proxied", count: 4 },
          { route: "attention", outcome: "unavailable", count: 0 },
        ],
      }),
    );
    expect(text).toContain("# TYPE myrmidon_board_singleton_proxy_total counter");
    expect(text).toContain('myrmidon_board_singleton_proxy_total{role="api",route="attention",outcome="proxied"} 4');
    expect(text).toContain('myrmidon_board_singleton_proxy_total{role="api",route="attention",outcome="unavailable"} 0');
    const bare = renderMetricsText(snapshot());
    expect(bare).toContain("# HELP myrmidon_board_singleton_proxy_total ");
    expect(bare).not.toContain("myrmidon_board_singleton_proxy_total{");
  });

  it("renders the lane families without samples when no lanes were read", () => {
    const text = renderMetricsText(snapshot());

    expect(text).toContain("myrmidon_board_db_queries_total");
    expect(text).toContain("myrmidon_board_lane_busy_seconds_total");
    expect(text).not.toContain("myrmidon_board_db_queries_total{");
    expect(text).not.toContain("myrmidon_board_lane_busy_seconds_total{");
  });


  // myrmidon(1.6.6-CH-CONNECTOR-G): the fallback chain of the bridge seam counts
  // per reason (design OPE-6985), so the exposition must show one sample per
  // reason when the counters were read, and the family with HELP/TYPE alone
  // when the collector has none.
  it("renders one sample per reason for the bridge fallback family", () => {
    const text = renderMetricsText(
      snapshot({
        adapterFallbacks: [
          { reason: "error", count: 3 },
          { reason: "timeout", count: 1 },
        ],
      }),
    );

    expect(text).toContain('myrmidon_adapter_fallback_total{reason="error"} 3');
    expect(text).toContain('myrmidon_adapter_fallback_total{reason="timeout"} 1');
  });

  it("renders the fallback family without samples when the counters were not read", () => {
    const text = renderMetricsText(snapshot());

    expect(text).toContain("# TYPE myrmidon_adapter_fallback_total counter");
    expect(text).toContain("# HELP myrmidon_adapter_fallback_total ");
    expect(text).not.toContain("myrmidon_adapter_fallback_total{");
  });

  // myrmidon(1.6.6 CONNECTOR-IN): the ingress counter rides the same scrape.
  // Both paths render whenever the counter was read — zero included, so the
  // operator reads "nothing goes through a connector yet" off the graph
  // instead of guessing it from a missing series.
  it("renders the ingress counter per path, zero included", () => {
    const read = renderMetricsText(snapshot({ chatIngress: { adapter: 3, direct: 4 } }));

    expect(read).toContain("# TYPE myrmidon_chat_ingress_total counter");
    expect(read).toContain('myrmidon_chat_ingress_total{path="adapter"} 3');
    expect(read).toContain('myrmidon_chat_ingress_total{path="direct"} 4');

    const idle = renderMetricsText(snapshot({ chatIngress: { adapter: 0, direct: 0 } }));

    expect(idle).toContain('myrmidon_chat_ingress_total{path="adapter"} 0');
    expect(idle).toContain('myrmidon_chat_ingress_total{path="direct"} 0');
  });

  // myrmidon(1.6.6 TMP-HYGIENE): the run scratch janitor volume.
  it("renders the run scratch volume, zero included, and no samples when unread", () => {
    const read = renderMetricsText(
      snapshot({
        runScratch: {
          removedDirsTotal: 2,
          removedBytesTotal: 2048,
          remainingDirs: 0,
          remainingBytes: 0,
          lastSweepAt: "2026-10-03T12:00:00.000Z",
        },
      }),
    );
    expect(read).toContain("# TYPE myrmidon_run_scratch_removed_bytes_total counter");
    expect(read).toContain("\nmyrmidon_run_scratch_removed_dirs_total 2\n");
    expect(read).toContain("\nmyrmidon_run_scratch_removed_bytes_total 2048\n");
    expect(read).toContain("# TYPE myrmidon_run_scratch_remaining_bytes gauge");
    expect(read).toContain("\nmyrmidon_run_scratch_remaining_dirs 0\n");
    expect(read).toContain("\nmyrmidon_run_scratch_remaining_bytes 0\n");

    const unread = renderMetricsText(snapshot());
    expect(unread).toContain("# HELP myrmidon_run_scratch_remaining_bytes ");
    expect(unread).not.toContain("\nmyrmidon_run_scratch_remaining_bytes ");
  });

  it("renders the ingress family without samples when the counter was not read", () => {
    const text = renderMetricsText(snapshot());

    expect(text).toContain("# HELP myrmidon_chat_ingress_total ");
    expect(text).not.toContain("myrmidon_chat_ingress_total{");
  });

  it("renders the process families without samples when there is no process read", () => {
    const text = renderMetricsText(snapshot({ process: null }));
    expect(text).toContain("# TYPE myrmidon_board_event_loop_lag_seconds summary");
    expect(text).toContain("# HELP myrmidon_board_live_events_total ");
    expect(text).not.toContain("myrmidon_board_event_loop_lag_seconds{");
    expect(text).not.toContain("myrmidon_board_live_events_total{");
    // The DB half is untouched by the missing process read.
    expect(text).toContain('myrmidon_runs_active{role="all"} 2');
  });

  it("omits the loop quantile samples while the histogram is not enabled", () => {
    const text = renderMetricsText(
      snapshot({ process: { eventLoop: null, eventLoopUtilization: null, memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 2 }, liveEvents: [] } }),
    );
    expect(text).not.toContain("myrmidon_board_event_loop_lag_seconds{");
    expect(text).toContain('myrmidon_board_process_rss_bytes{role="all"} 1');
    expect(text).toContain("# TYPE myrmidon_board_live_events_total counter");
    expect(text).not.toContain("myrmidon_board_live_events_total{");
  });

  it("renders run duration quantiles with the quantile label", () => {
    const text = renderMetricsText(snapshot());
    expect(text).toContain('myrmidon_run_duration_seconds{role="all",quantile="0.5"} 42.5');
    expect(text).toContain('myrmidon_run_duration_seconds{role="all",quantile="0.95"} 130.25');
  });

  it("omits quantile samples when there is no finished run in the window", () => {
    const text = renderMetricsText(
      snapshot({ runDurationSecondsP50: null, runDurationSecondsP95: null }),
    );
    expect(text).toContain("# TYPE myrmidon_run_duration_seconds summary");
    expect(text).not.toContain('myrmidon_run_duration_seconds{quantile=');
  });

  // myrmidon(1.6.6-CORPUS-SHADOW A): the two shadow-leg summaries. With the
  // flag off (the default) the collector reads no rows and the families stay
  // sample-less; with rows in the window both quantiles render per leg.
  it("renders corpus shadow leg quantiles with the quantile label", () => {
    const text = renderMetricsText(
      snapshot({
        corpusShadowRagflowSecondsP50: 0.41,
        corpusShadowRagflowSecondsP95: 1.93,
        corpusShadowModuleSecondsP50: 0.07,
        corpusShadowModuleSecondsP95: 0.25,
      }),
    );
    expect(text).toContain('myrmidon_corpus_shadow_ragflow_latency_seconds{quantile="0.5"} 0.41');
    expect(text).toContain('myrmidon_corpus_shadow_ragflow_latency_seconds{quantile="0.95"} 1.93');
    expect(text).toContain('myrmidon_corpus_shadow_module_latency_seconds{quantile="0.5"} 0.07');
    expect(text).toContain('myrmidon_corpus_shadow_module_latency_seconds{quantile="0.95"} 0.25');
    expect(text).toContain("# TYPE myrmidon_corpus_shadow_ragflow_latency_seconds summary");
    expect(text).toContain("# TYPE myrmidon_corpus_shadow_module_latency_seconds summary");
  });

  it("keeps corpus shadow families sample-less when no rows were written", () => {
    // The snapshot fields are optional: the collector zeroes them when the
    // table is empty, which is exactly the flag-off (byte-for-byte default)
    // shape the exposition test feeds here by leaving them unset.
    const text = renderMetricsText(snapshot());
    expect(text).toContain("# TYPE myrmidon_corpus_shadow_ragflow_latency_seconds summary");
    expect(text).not.toContain("myrmidon_corpus_shadow_ragflow_latency_seconds{");
    expect(text).toContain("# TYPE myrmidon_corpus_shadow_module_latency_seconds summary");
    expect(text).not.toContain("myrmidon_corpus_shadow_module_latency_seconds{");
  });

  it("ends with a newline and separates families with blank lines", () => {
    const text = renderMetricsText(snapshot());
    expect(text.endsWith("\n")).toBe(true);
    const body = text.slice(0, -1);
    const blocks = body.split("\n\n");
    const families = blocks.map((block) => {
      // Check registered names, including the task's blocker_* families,
      // rather than imposing a namespace on otherwise valid exposition.
      const match = /^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) /.exec(block);
      expect(match).not.toBeNull();
      expect(block.split("\n")[1]).toMatch(new RegExp(`^# TYPE ${match![1]} `));
      return match![1];
    });
    expect(families.sort()).toEqual([...METRIC_FAMILIES].sort());
  });

  it("escapes label values the way the exposition format requires", () => {
    const text = renderMetricsText(
      snapshot({
        roleQueueTasks: [{ role: 'eng"ni\\er\nx', status: "todo", count: 1 }],
      }),
    );
    expect(text).toContain('myrmidon_role_queue_tasks{role="all",assignee_role="eng\\"ni\\\\er\\nx",status="todo"} 1');
  });

  it("formats sample values without NaN or exponent noise", () => {
    expect(formatSampleValue(0)).toBe("0");
    expect(formatSampleValue(42)).toBe("42");
    expect(formatSampleValue(42.5)).toBe("42.5");
    expect(formatSampleValue(0.1234567)).toBe("0.123457");
  });

  it("computes interpolated percentiles of a sorted sample", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(4.8);
  });

  it("escapeLabelValue round-trips the metacharacters", () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(escapeLabelValue("plain")).toBe("plain");
  });
});

// myrmidon(1.6.6 REMOTE-SITES-T4): the remote-site families.
describe("remote site families", () => {
  it("render reachable, last_seen, retries and moves with escaped labels", () => {
    const text = renderMetricsText(
      snapshot({
        fleetSites: {
          sites: [{ site: 'myr"vm1', reachable: 1, lastSeenSeconds: 5 }, { site: "never", reachable: 0, lastSeenSeconds: null }],
          retriesTotal: [{ site: "myr-vm1", count: 3 }],
          movesTotal: [{ result: "done", count: 1 }, { result: "failed", count: 0 }, { result: "unavailable", count: 2 }],
        },
      }),
    );
    expect(text).toContain("# TYPE myrmidon_fleet_site_reachable gauge");
    expect(text).toContain('myrmidon_fleet_site_reachable{site="myr\\"vm1"} 1');
    expect(text).toContain('myrmidon_fleet_site_reachable{site="never"} 0');
    expect(text).toContain('myrmidon_fleet_site_last_seen_seconds{site="myr\\"vm1"} 5');
    // A site that never answered has no last-seen sample.
    expect(text).not.toContain('myrmidon_fleet_site_last_seen_seconds{site="never"}');
    expect(text).toContain("# TYPE myrmidon_fleet_exec_retries_total counter");
    expect(text).toContain('myrmidon_fleet_exec_retries_total{site="myr-vm1"} 3');
    expect(text).toContain('myrmidon_fleet_moves_total{result="unavailable"} 2');
  });

  it("render HELP and TYPE with no samples when the source is absent", () => {
    const text = renderMetricsText(snapshot({ fleetSites: null }));
    expect(text).toContain("# HELP myrmidon_fleet_moves_total ");
    expect(text).not.toContain("myrmidon_fleet_moves_total{");
  });
});
