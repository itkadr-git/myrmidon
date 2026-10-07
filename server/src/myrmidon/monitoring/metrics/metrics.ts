// server/src/myrmidon/monitoring/metrics/metrics.ts
//
// myrmidon(1.7-METRICS): the Prometheus text exposition of the board itself.
//
// The instance is scraped by the existing monitoring stack, so the board
// answers `GET /metrics` in the Prometheus text exposition format
// (version 0.0.4) at the origin root — NOT under /api, the same outside-/api
// shape the swarm-claim ingress uses. Everything is computed on the fly from
// the tables the board already writes (heartbeat runs, issues with their
// assignee roles, issue claims, litellm cost events, agent error signals);
// there is no new storage, table or migration behind this module.
//
// The file split:
//  - metrics.ts (this file) — the metric families, the pure rendering into
//    exposition text, and the collection port the routes drive. No DB import
//    lives here: the read side is a port so routes tests run on fakes.
//  - routes.ts — the express router: bearer guard + the endpoint.
//  - index.ts — the app wiring (app.ts mounts that).

import { and, count, eq, gt, gte, isNotNull, isNull, sql } from "drizzle-orm";
import {
  agents,
  companies,
  heartbeatRuns,
  issueClaims,
  issues,
  litellmCostEvents,
  type Db,
} from "@paperclipai/db";
import { readTracingHealthAttentionSignal } from "../../tracing-health/attention.js";
import { readStaleBlockSignals } from "../../stale-block/attention.js";
import {
  readSwarmClaimAttentionSignals,
} from "./swarm-signals.js";
import {
  resolveProcessMetricsSource,
  type ProcessMetricsSample,
  type ProcessMetricsSource,
} from "./process-metrics.js";

/** Content type of the Prometheus text exposition format, version 0.0.4. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** The scraper may pass `?window=…` (seconds) for the error window; bounded. */
export const DEFAULT_ERROR_WINDOW_SEC = 3600;
const MIN_ERROR_WINDOW_SEC = 60;
const MAX_ERROR_WINDOW_SEC = 86400;

/** Runs stay "recent" for latency this long (seconds); p50/p95 read this window. */
export const DEFAULT_LATENCY_WINDOW_SEC = 6 * 3600;
const MIN_LATENCY_WINDOW_SEC = 300;
const MAX_LATENCY_WINDOW_SEC = 86400;
/** Cap on runs sampled for percentiles; a ceiling, not a page size. */
const LATENCY_SAMPLE_CAP = 5000;

// ---------------------------------------------------------------------------
// Metric families
// ---------------------------------------------------------------------------

/**
 * Metric families the endpoint serves. Every family renders HELP and TYPE
 * once, followed by its samples; unknown label values are escaped.
 */
export const METRIC_FAMILIES = [
  "myrmidon_runs_active",
  "myrmidon_runs_queued",
  "myrmidon_runs_failed_total",
  "myrmidon_runs_failed_window",
  "myrmidon_run_duration_seconds",
  "myrmidon_role_queue_tasks",
  "myrmidon_swarm_claims_active",
  "myrmidon_swarm_claims_total",
  "myrmidon_agent_error_signals",
  "myrmidon_llm_cost_cents_total",
  "myrmidon_scrape_errors",
  // myrmidon(1.6.5-PROCS-Q3): the process families — the loop delay, the
  // memory of this process, and the live-event flow (design §1, этап 0).
  "myrmidon_board_event_loop_lag_seconds",
  "myrmidon_board_process_rss_bytes",
  "myrmidon_board_heap_bytes",
  "myrmidon_board_live_events_total",
  "myrmidon_board_live_event_bytes_total",
] as const;

export type MetricFamily = (typeof METRIC_FAMILIES)[number];

// ---------------------------------------------------------------------------
// Scrape snapshot
// ---------------------------------------------------------------------------

/** The per-family values one scrape reads (the selfcheck probe shares them). */
export interface MetricsSnapshotFields {
  /** Live (running) runs right now. */
  runsActive: number;
  /** Queued runs waiting for admission right now. */
  runsQueued: number;
  /** Failed runs, all time. */
  runsFailedTotal: number;
  /** Failed runs inside the error window. */
  runsFailedWindow: number;
  /** p50/p95 of finished run durations inside the latency window (seconds). */
  runDurationSecondsP50: number | null;
  runDurationSecondsP95: number | null;
  /** Issue counts per assignee role and status. */
  roleQueueTasks: Array<{ role: string; status: string; count: number }>;
  /** Live (not released, not expired) SWARM claims. */
  swarmClaimsActive: number;
  /** All SWARM claim rows ever written. */
  swarmClaimsTotal: number;
  /** Live agent error signals across companies (attention registries). */
  agentErrorSignals: number;
  /** Cost spend collected by litellm-costs inside the error window, in cents. */
  llmCostCentsWindow: number;
  /**
   * myrmidon(1.6.5-PROCS-Q3): the process half, read from the in-process
   * source (no DB). null renders HELP/TYPE with no samples — the families
   * exist even before the first event of a kind was published.
   */
  process?: ProcessMetricsSample | null;
}

/** The fields plus the scrape bookkeeping rendered into the exposition text. */
export interface MetricsSnapshot extends MetricsSnapshotFields {
  /** Non-fatal collection errors of this scrape (already logged upstream). */
  scrapeErrors: number;
  /** When the snapshot was taken. */
  collectedAt: string;
}

// ---------------------------------------------------------------------------
// Port: where the numbers come from
// ---------------------------------------------------------------------------

export interface MetricsCollectorDeps {
  db: Db;
  /** Fixed clock for tests. */
  now(): Date;
  /** Error window in seconds (from the request or the default). */
  errorWindowSec: number;
  /** Latency window in seconds. */
  latencyWindowSec: number;
  /**
   * myrmidon(1.6.5-PROCS-Q3): where the process half comes from. Production
   * reads the in-process observers; tests inject fakes. Absent → the
   * production default (no fake needed for the DB families).
   */
  processMetrics?: ProcessMetricsSource | null;
}

/** Reads the run counters — one grouped query, whole instance. */
async function readRunCounters(db: Db): Promise<{
  active: number;
  queued: number;
  failedTotal: number;
}> {
  const rows = await db
    .select({
      status: heartbeatRuns.status,
      total: count(),
    })
    .from(heartbeatRuns)
    .groupBy(heartbeatRuns.status);
  let active = 0;
  let queued = 0;
  let failedTotal = 0;
  for (const row of rows) {
    if (row.status === "running" || row.status === "claimed") active += Number(row.total);
    else if (row.status === "queued" || row.status === "retrying" || row.status === "scheduled_retry") {
      queued += Number(row.total);
    } else if (row.status === "failed") failedTotal += Number(row.total);
  }
  return { active, queued, failedTotal };
}

/** p50/p95 over finished run durations (finishedAt - startedAt), seconds. */
async function readRunDurations(
  db: Db,
  windowStart: Date,
): Promise<{ p50: number | null; p95: number | null; samples: number }> {
  const rows = await db
    .select({
      seconds: sql<number>`extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt}))`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        isNotNull(heartbeatRuns.finishedAt),
        isNotNull(heartbeatRuns.startedAt),
        gte(heartbeatRuns.finishedAt, windowStart),
      ),
    )
    .orderBy(heartbeatRuns.finishedAt)
    .limit(LATENCY_SAMPLE_CAP);
  const durations = rows
    .map((row) => Number(row.seconds))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (durations.length === 0) return { p50: null, p95: null, samples: 0 };
  return { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), samples: durations.length };
}

/** Linear-interpolated percentile of an ascending-sorted sample. */
export function percentile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) throw new Error("percentile of an empty sample");
  if (q <= 0) return sortedValues[0]!;
  if (q >= 1) return sortedValues[sortedValues.length - 1]!;
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower]!;
  const weight = position - lower;
  return sortedValues[lower]! * (1 - weight) + sortedValues[upper]! * weight;
}

/** Issue counts per (assignee role, status) — the per-role queue view. */
async function readRoleQueues(db: Db): Promise<Array<{ role: string; status: string; count: number }>> {
  const rows = await db
    .select({
      role: agents.role,
      status: issues.status,
      total: count(),
    })
    .from(issues)
    .innerJoin(agents, eq(agents.id, issues.assigneeAgentId))
    .groupBy(agents.role, issues.status);
  return rows.map((row) => ({
    role: row.role ?? "general",
    status: row.status,
    count: Number(row.total),
  }));
}

/** SWARM claim counters — live claims and all rows ever. */
async function readClaimCounters(
  db: Db,
  now: Date,
): Promise<{ active: number; total: number }> {
  const [liveRow] = await db
    .select({ total: count() })
    .from(issueClaims)
    .where(and(isNull(issueClaims.releasedAt), gt(issueClaims.expiresAt, now)));
  const [totalRow] = await db.select({ total: count() }).from(issueClaims);
  return { active: Number(liveRow?.total ?? 0), total: Number(totalRow?.total ?? 0) };
}

/**
 * Agent error signals: the in-process attention registries the sweeps keep
 * (tracing-health, stale-block, swarm-claim). Read across all companies, one
 * number per registry — no new store is created for this.
 */
async function readAgentErrorSignals(db: Db): Promise<number> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(isNotNull(companies.id))
    .catch(() => [] as Array<{ id: string }>);
  let signals = 0;
  for (const row of rows) {
    if (readTracingHealthAttentionSignal(row.id)) signals += 1;
    signals += readStaleBlockSignals(row.id).length;
    signals += readSwarmClaimAttentionSignals(row.id).length;
  }
  return signals;
}

/** LiteLLM-collected spend inside the window, in cents (the M2-A ledger). */
async function readCostWindow(db: Db, windowStart: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${litellmCostEvents.costCents}), 0)` })
    .from(litellmCostEvents)
    .where(gte(litellmCostEvents.occurredAt, windowStart));
  return Number(row?.total ?? 0);
}

/** One scrape: every family is collected, and one family's failure never kills the rest. */
export async function collectMetricsSnapshot(deps: MetricsCollectorDeps): Promise<MetricsSnapshot> {
  const collected = await collectMetricsParts(deps);
  return {
    ...collected.fields,
    scrapeErrors: collected.errors.length,
    collectedAt: collected.now.toISOString(),
  };
}

/** Per-family outcome of one scrape, shared by the snapshot and the selfcheck probe. */
export interface MetricsCollectedParts {
  fields: MetricsSnapshotFields;
  /** Family names whose read failed (empty on a clean scrape). */
  errors: string[];
  /** The clock value the scrape used. */
  now: Date;
  /** Latency sample sizes behind the p50/p95 pair. */
  latencySamples: number;
}

/**
 * Collects one snapshot's worth of fields family by family. A family that
 * throws falls back to its zero/empty value and lands in `errors`: one broken
 * read never kills the scrape, and the failure is visible upstream as
 * `myrmidon_scrape_errors` — the alerting half maps that counter to a task
 * for the owning role.
 */
export async function collectMetricsParts(deps: MetricsCollectorDeps): Promise<MetricsCollectedParts> {
  const now = deps.now();
  const errorWindowStart = new Date(now.getTime() - deps.errorWindowSec * 1000);
  const latencyWindowStart = new Date(now.getTime() - deps.latencyWindowSec * 1000);

  const errors: string[] = [];
  async function guarded<T>(family: string, read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch {
      errors.push(family);
      return fallback;
    }
  }

  // The run counters answer three families with one grouped query; a failure
  // names all three in the selfcheck output.
  const runCounters = await guarded(
    "myrmidon_runs_active|myrmidon_runs_queued|myrmidon_runs_failed_total",
    () => readRunCounters(deps.db),
    { active: 0, queued: 0, failedTotal: 0 },
  );
  const durations = await guarded(
    "myrmidon_run_duration_seconds",
    () => readRunDurations(deps.db, latencyWindowStart),
    { p50: null, p95: null, samples: 0 },
  );
  const roleQueues = await guarded(
    "myrmidon_role_queue_tasks",
    () => readRoleQueues(deps.db),
    [] as Array<{ role: string; status: string; count: number }>,
  );
  const claimCounters = await guarded(
    "myrmidon_swarm_claims_active|myrmidon_swarm_claims_total",
    () => readClaimCounters(deps.db, now),
    { active: 0, total: 0 },
  );
  const errorSignals = await guarded(
    "myrmidon_agent_error_signals",
    () => readAgentErrorSignals(deps.db),
    0,
  );
  const costWindow = await guarded(
    "myrmidon_llm_cost_cents_total",
    () => readCostWindow(deps.db, errorWindowStart),
    0,
  );
  const failedWindow = await guarded(
    "myrmidon_runs_failed_window",
    () =>
      deps.db
        .select({ total: count() })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.status, "failed"), gte(heartbeatRuns.finishedAt, errorWindowStart)))
        .then((rows) => Number(rows[0]?.total ?? 0)),
    0,
  );
  // myrmidon(1.6.5-PROCS-Q3): the process half rides the same guarded
  // scrape: a throwing source zeroes it (HELP/TYPE render without samples)
  // and names the five families, never kills the scrape.
  const processSample = await guarded(
    "myrmidon_board_event_loop_lag_seconds|myrmidon_board_process_rss_bytes|myrmidon_board_heap_bytes|myrmidon_board_live_events_total|myrmidon_board_live_event_bytes_total",
    () => Promise.resolve().then(resolveProcessMetricsSource(deps.processMetrics)),
    null as ProcessMetricsSample | null,
  );

  return {
    fields: {
      runsActive: runCounters.active,
      runsQueued: runCounters.queued,
      runsFailedTotal: runCounters.failedTotal,
      runsFailedWindow: failedWindow,
      runDurationSecondsP50: durations.p50,
      runDurationSecondsP95: durations.p95,
      roleQueueTasks: roleQueues,
      swarmClaimsActive: claimCounters.active,
      swarmClaimsTotal: claimCounters.total,
      agentErrorSignals: errorSignals,
      llmCostCentsWindow: costWindow,
      process: processSample,
    },
    errors,
    now,
    latencySamples: durations.samples,
  };
}

/**
 * The self-check probe (myrmidon 1.6.6 annex): one scrape of every family,
 * summarised without any secret or metric value. Answers whether the whole
 * chain the board owns works: DB reads for each family and the exposition
 * render of the collected snapshot. `families_failed` names the families
 * whose read threw — the same per-family failures the scrape counter
 * exposes to the monitoring stack, from which the alerting half opens a
 * task for the owning role.
 */
export interface MetricsSelfCheck {
  ok: boolean;
  families_ok: number;
  families_failed: string[];
  scrape_ms: number;
  /** When the probe ran. */
  checked_at: string;
}

export async function runMetricsSelfCheck(deps: MetricsCollectorDeps): Promise<MetricsSelfCheck> {
  const startedAt = Date.now();
  const collected = await collectMetricsParts(deps);
  // The render is part of the probe: a family that collects but cannot be
  // rendered would hand the scraper a broken response.
  try {
    renderMetricsText({
      ...collected.fields,
      scrapeErrors: collected.errors.length,
      collectedAt: collected.now.toISOString(),
    });
  } catch {
    collected.errors.push("exposition_render");
  }
  const failed = new Set(collected.errors.flatMap((entry) => entry.split("|")));
  return {
    ok: failed.size === 0,
    families_ok: METRIC_FAMILIES.filter((family) => !failed.has(family)).length,
    families_failed: [...failed].sort(),
    scrape_ms: Date.now() - startedAt,
    checked_at: collected.now.toISOString(),
  };
}

/** Clamps the requested error window (seconds) to the documented bounds. */
export function clampErrorWindowSec(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : DEFAULT_ERROR_WINDOW_SEC;
  if (!Number.isFinite(value)) return DEFAULT_ERROR_WINDOW_SEC;
  if (value < MIN_ERROR_WINDOW_SEC) return MIN_ERROR_WINDOW_SEC;
  if (value > MAX_ERROR_WINDOW_SEC) return MAX_ERROR_WINDOW_SEC;
  return Math.floor(value);
}

/** Clamps the latency window (seconds) to the documented bounds. */
export function clampLatencyWindowSec(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : DEFAULT_LATENCY_WINDOW_SEC;
  if (!Number.isFinite(value)) return DEFAULT_LATENCY_WINDOW_SEC;
  if (value < MIN_LATENCY_WINDOW_SEC) return MIN_LATENCY_WINDOW_SEC;
  if (value > MAX_LATENCY_WINDOW_SEC) return MAX_LATENCY_WINDOW_SEC;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Escapes a label value for the exposition format (backslash, quote, newline). */
export function escapeLabelValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

/** Renders a floating-point sample value the way the format prints them. */
export function formatSampleValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function familyBlock(
  name: string,
  help: string,
  type: "gauge" | "counter" | "summary",
  samples: string[],
): string {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples].join("\n");
}

/**
 * Renders the snapshot as Prometheus text exposition (0.0.4): every family
 * has exactly one HELP and one TYPE line, families are separated by a blank
 * line, and a value is never a bare `NaN`/`Infinity`.
 */
export function renderMetricsText(snapshot: MetricsSnapshot): string {
  const blocks: string[] = [];

  blocks.push(
    familyBlock(
      "myrmidon_runs_active",
      "Heartbeat runs currently running or claimed.",
      "gauge",
      [`myrmidon_runs_active ${formatSampleValue(snapshot.runsActive)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_runs_queued",
      "Heartbeat runs waiting for admission (queued, retrying, scheduled_retry).",
      "gauge",
      [`myrmidon_runs_queued ${formatSampleValue(snapshot.runsQueued)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_runs_failed_total",
      "Heartbeat runs with status failed, all time.",
      "gauge",
      [`myrmidon_runs_failed_total ${formatSampleValue(snapshot.runsFailedTotal)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_runs_failed_window",
      "Failed heartbeat runs inside the scrape error window.",
      "gauge",
      [`myrmidon_runs_failed_window ${formatSampleValue(snapshot.runsFailedWindow)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_run_duration_seconds",
      "Run duration quantiles (finishedAt - startedAt) over the latency window.",
      "summary",
      [
        ...(snapshot.runDurationSecondsP50 !== null
          ? [`myrmidon_run_duration_seconds{quantile=\"0.5\"} ${formatSampleValue(snapshot.runDurationSecondsP50)}`]
          : []),
        ...(snapshot.runDurationSecondsP95 !== null
          ? [`myrmidon_run_duration_seconds{quantile=\"0.95\"} ${formatSampleValue(snapshot.runDurationSecondsP95)}`]
          : []),
      ],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_role_queue_tasks",
      "Issues by assignee role and status.",
      "gauge",
      snapshot.roleQueueTasks.map(
        (row) =>
          `myrmidon_role_queue_tasks{role="${escapeLabelValue(row.role)}",status="${escapeLabelValue(row.status)}"} ${formatSampleValue(row.count)}`,
      ),
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_swarm_claims_active",
      "Live (not released, not expired) SWARM claims.",
      "gauge",
      [`myrmidon_swarm_claims_active ${formatSampleValue(snapshot.swarmClaimsActive)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_swarm_claims_total",
      "SWARM claim rows ever written (issue_claims rows).",
      "counter",
      [`myrmidon_swarm_claims_total ${formatSampleValue(snapshot.swarmClaimsTotal)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_agent_error_signals",
      "Live agent error signals in the attention registries (tracing health, stale blocks, swarm claims).",
      "gauge",
      [`myrmidon_agent_error_signals ${formatSampleValue(snapshot.agentErrorSignals)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_llm_cost_cents_total",
      "LLM spend collected by the gateway cost sweep inside the scrape window, in cents.",
      "counter",
      [`myrmidon_llm_cost_cents_total ${formatSampleValue(snapshot.llmCostCentsWindow)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_scrape_errors",
      "Metric families that failed to collect during this scrape.",
      "gauge",
      [`myrmidon_scrape_errors ${formatSampleValue(snapshot.scrapeErrors)}`],
    ),
  );

  // myrmidon(1.6.5-PROCS-Q3): the process families. An absent/failed process
  // read renders HELP/TYPE with no samples — the scrape still answers.
  const proc = snapshot.process ?? null;
  blocks.push(
    familyBlock(
      "myrmidon_board_event_loop_lag_seconds",
      "Event loop delay of the board process (p50/p99/max) since the previous scrape.",
      "summary",
      proc && proc.eventLoop
        ? [
            `myrmidon_board_event_loop_lag_seconds{quantile="0.5"} ${formatSampleValue(proc.eventLoop.p50Seconds)}`,
            `myrmidon_board_event_loop_lag_seconds{quantile="0.99"} ${formatSampleValue(proc.eventLoop.p99Seconds)}`,
            `myrmidon_board_event_loop_lag_seconds{quantile="1"} ${formatSampleValue(proc.eventLoop.maxSeconds)}`,
          ]
        : [],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_board_process_rss_bytes",
      "Resident set size of the board process.",
      "gauge",
      proc ? [`myrmidon_board_process_rss_bytes ${formatSampleValue(proc.memory.rssBytes)}`] : [],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_board_heap_bytes",
      "V8 heap of the board process by kind label (used / total).",
      "gauge",
      proc
        ? [
            `myrmidon_board_heap_bytes{kind="used"} ${formatSampleValue(proc.memory.heapUsedBytes)}`,
            `myrmidon_board_heap_bytes{kind="total"} ${formatSampleValue(proc.memory.heapTotalBytes)}`,
          ]
        : [],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_board_live_events_total",
      "Live events published by kind, cumulative since boot.",
      "counter",
      proc
        ? proc.liveEvents.map(
            (row) =>
              `myrmidon_board_live_events_total{kind="${escapeLabelValue(row.type)}"} ${formatSampleValue(row.count)}`,
          )
        : [],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_board_live_event_bytes_total",
      "Serialized payload bytes of published live events by kind, cumulative since boot.",
      "counter",
      proc
        ? proc.liveEvents.map(
            (row) =>
              `myrmidon_board_live_event_bytes_total{kind="${escapeLabelValue(row.type)}"} ${formatSampleValue(row.bytes)}`,
          )
        : [],
    ),
  );

  return `${blocks.join("\n\n")}\n`;
}
