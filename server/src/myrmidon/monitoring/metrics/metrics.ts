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
  corpusShadowLog,
  heartbeatRuns,
  issueClaims,
  issues,
  litellmCostEvents,
  type Db,
} from "@myrmidon/db";
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
import {
  resolveLaneMetricsSource,
  type BoardLaneMetricsSource,
  type BoardLaneSample,
} from "../board-load/lanes.js";

import {
  resolveChannelBridgeFallbackSource,
  type ChannelBridgeFallbackSample,
  type ChannelBridgeFallbackSource,
} from "../../channel-connectors/bridge/fallback-counters.js";
import {
  resolveSingletonProxySource,
  type SingletonProxySample,
  type SingletonProxySource,
} from "../../singleton-proxy/counters.js"; // myrmidon(1.6.6 PROCS-1.5 / OPE-5412)
import { readFleetSiteMetrics, type FleetSiteMetricsSample } from "../../bot-containers/fleet-site-metrics.js"; // myrmidon(1.6.6 REMOTE-SITES-T4)
import { resolveBoardProcessRole } from "../../process-registry/domain.js";
import { collectBlockerRootMetrics, renderBlockerRootMetrics, type BlockerRootMetrics } from "./blocker-roots.js";
import { swarmClaimMetrics, SWARM_LEASE_RECOVERY_REASONS } from "../../swarm-claim/metrics.js";
import { continuationDedupeMetrics } from "../../../services/continuation-dedupe-metrics.js";
import { collectBlockedMetrics, type BlockedMetricsGroup } from "./blocked.js";
import { loadBlockedGraph } from "../../../services/blocker-graph/load-edges.js";

// myrmidon(1.6.6 CONNECTOR-IN): the inbound reads of the channel connectors —
// the in-process counter the ingress seam keeps (design section 4 and 7).
import {
  channelIngressCounters,
  type ChannelIngressCounters,
} from "../../channel-connectors/ingress.js";

// myrmidon(1.6.6 TMP-HYGIENE): volume of the heartbeat run scratch janitor
// (in-process state of the sweeper, no DB).
import {
  heartbeatRunScratchMetrics,
  type HeartbeatRunScratchMetrics,
} from "../../../services/run-scratch.js";

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
  "blocked_age_seconds",
  "blocked_missing_fields_total",
  "myrmidon_runs_active",
  "myrmidon_runs_queued",
  "myrmidon_runs_failed_total",
  "myrmidon_runs_failed_window",
  "myrmidon_run_duration_seconds",
  "myrmidon_role_queue_tasks",
  "myrmidon_swarm_claims_active",
  "myrmidon_swarm_claims_total",
  "swarm_claim_conflicts_total",
  "swarm_lease_recovered_total",
  "myrmidon_agent_error_signals",
  "myrmidon_llm_cost_cents_total",
  "myrmidon_scrape_errors",
  // Process-local continuation claims; continuation keys are not labels.
  "myrmidon_continuation_created_total",
  "myrmidon_continuation_deduped_total",
  // myrmidon(1.6.5-PROCS-Q3): the process families — the loop delay, the
  // memory of this process, and the live-event flow (design §1, этап 0).
  "myrmidon_board_event_loop_lag_seconds",
  // myrmidon(1.6.6 PROCS-0.1): event-loop utilization (design §5.1, этап 0).
  "myrmidon_board_event_loop_utilization",
  "myrmidon_board_process_rss_bytes",
  "myrmidon_board_heap_bytes",
  "myrmidon_board_live_events_total",
  "myrmidon_board_live_event_bytes_total",
  // myrmidon(1.6.6-PROCS-0.3A): the load lanes — which shape of board work
  // spends the CPU and issues the DB statements (design OPE-5394 §1 П2).
  "myrmidon_board_db_queries_total",
  "myrmidon_board_lane_busy_seconds_total",
  // myrmidon(1.6.6 PROCS-1.5 / OPE-5412): single routes forwarded by an api
  // process to the worker, per route group and outcome.
  "myrmidon_board_singleton_proxy_total",

  // myrmidon(1.6.6-CH-CONNECTOR-G): the fallback chain of the bridge seam — how
  // often the channel adapter did not answer and the direct path took the call
  // back, per reason (design OPE-6985).
  "myrmidon_adapter_fallback_total",

  // myrmidon(1.6.6 CONNECTOR-IN): the inbound reads of the channel connectors
  // by path — the adapter and the vendor path that still reads in parallel
  // (design section 4, the inbound flow).
  "myrmidon_chat_ingress_total",

  // myrmidon(1.6.6 TMP-HYGIENE): the run scratch janitor — what it removed and
  // what stays in the temp directory.
  "myrmidon_run_scratch_removed_dirs_total",
  "myrmidon_run_scratch_removed_bytes_total",
  "myrmidon_run_scratch_remaining_dirs",
  "myrmidon_run_scratch_remaining_bytes",

  // myrmidon(1.6.6 REMOTE-SITES-T4): the remote sites — probe result and age per site, the runs
  // requeued after a site was lost, and the failover moves by result (design remote-sites-v2 7.1).
  "myrmidon_fleet_site_reachable",
  "myrmidon_fleet_site_last_seen_seconds",
  "myrmidon_fleet_exec_retries_total",
  "myrmidon_fleet_moves_total",

  // myrmidon(1.6.6-CORPUS-SHADOW A): p50/p95 of both shadow legs (part
  // A) read from corpus_shadow_log inside the latency window. With the
  // flag off the table stays empty and the families render HELP/TYPE only.
  "myrmidon_corpus_shadow_ragflow_latency_seconds",
  "myrmidon_corpus_shadow_module_latency_seconds",
  "blocker_root_fanout",
  "blocker_terminal_count",
  "blocker_roots_over_limit",
] as const;

export type MetricFamily = (typeof METRIC_FAMILIES)[number];

// ---------------------------------------------------------------------------
// Scrape snapshot
// ---------------------------------------------------------------------------

/** The per-family values one scrape reads (the selfcheck probe shares them). */
export interface MetricsSnapshotFields {
  blocked?: Array<{ companyId: string; groups: BlockedMetricsGroup[] }>;
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
  /**
   * myrmidon(1.6.6-PROCS-0.3A): the load lanes of this process, read from the
   * in-process registry (no DB). null renders HELP/TYPE with no samples —
   * the two families exist even before the first lane ran.
   */
  lanes?: BoardLaneSample[] | null;
  /**
   * myrmidon(1.6.6-CH-CONNECTOR-G): the bridge fallback counters of this
   * process, read from the in-process registry (no DB). null renders HELP/TYPE
   * with no samples; a present sample renders every known reason, zeros
   * included, so a missing series can only mean an unwired counter.
   */
  adapterFallbacks?: ChannelBridgeFallbackSample[] | null;
  /**
   * myrmidon(1.6.6 PROCS-1.5 / OPE-5412): the single-route proxy counters of
   * this process (in-process, no DB). null renders HELP/TYPE with no samples; a
   * present sample renders every route x outcome, zeros included.
   */
  singletonProxy?: SingletonProxySample[] | null;

  /**
   * myrmidon(1.6.6 CONNECTOR-IN): the inbound reads of this process by path,
   * read from the in-process counter of the connector seam (no DB). null
   * renders HELP/TYPE with no samples; both paths render as samples whenever
   * the counter was read — zero included, so "nothing reads through a
   * connector yet" is readable off the graph.
   */
  chatIngress?: ChannelIngressCounters | null;

  /**
   * myrmidon(1.6.6 TMP-HYGIENE): the run scratch janitor volume of this
   * process. null renders HELP/TYPE with no samples.
   */
  runScratch?: HeartbeatRunScratchMetrics | null;

  /**
   * myrmidon(1.6.6 REMOTE-SITES-T4): the remote-site gauges and counters of this
   * process (in-process, no DB). null renders HELP/TYPE with no samples.
   */
  fleetSites?: FleetSiteMetricsSample | null;
  blockerRoots?: BlockerRootMetrics | null;

  /**
   * myrmidon(1.6.6-CORPUS-SHADOW A): p50/p95 of the two shadow legs in
   * seconds, read from corpus_shadow_log inside the latency window. Absent
   * or null (flag off — the table stays empty) renders HELP/TYPE with no
   * samples, the same shape the run-duration summary uses with no rows.
   */
  corpusShadowRagflowSecondsP50?: number | null;
  corpusShadowRagflowSecondsP95?: number | null;
  corpusShadowModuleSecondsP50?: number | null;
  corpusShadowModuleSecondsP95?: number | null;
}

/** The fields plus the scrape bookkeeping rendered into the exposition text. */
export interface MetricsSnapshot extends MetricsSnapshotFields {
  /**
   * myrmidon(1.6.6 OPE-6959, design BOARD-PROCESSES этап 1): the process role
   * (`api` | `worker` | `all`) of the process that answered this scrape. It is
   * rendered as the `role` label on EVERY sample, so the same instance can be
   * scraped through N api processes and one worker and the monitoring stack
   * tells them apart without relabel rules on the scrape config. The metric
   * NAMES do not change — only the label set grows.
   */
  role: string;
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
   * myrmidon(1.6.6 OPE-6959): the process role stamped on every sample as the
   * `role` label. Absent → resolved from `PAPERCLIP_PROCESS_ROLE` (the same
   * resolution the process registry uses), so `mode=single` keeps rendering
   * `role="all"`.
   */
  role?: string;
  /**
   * myrmidon(1.6.5-PROCS-Q3): where the process half comes from. Production
   * reads the in-process observers; tests inject fakes. Absent → the
   * production default (no fake needed for the DB families).
   */
  processMetrics?: ProcessMetricsSource | null;
  /**
   * myrmidon(1.6.6-PROCS-0.3A): where the lane half comes from. Production
   * reads the in-process registry; tests inject fakes. Absent → the
   * production default — a test that renders lanes injects its own source,
   * so no test ever depends on another test's counters.
   */
  laneMetrics?: BoardLaneMetricsSource | null;
  /**
   * myrmidon(1.6.6-CH-CONNECTOR-G): where the bridge fallback counters come
   * from. Production reads the in-process registry of the seam; tests inject a
   * fake, so no test depends on another test's fallbacks.
   */
  adapterFallbacks?: ChannelBridgeFallbackSource | null;
  /** myrmidon(1.6.6 PROCS-1.5 / OPE-5412): where the proxy counters come from; tests inject a fake. */
  singletonProxy?: SingletonProxySource | null;

  /**
   * myrmidon(1.6.6 CONNECTOR-IN): where the ingress half comes from. Production
   * reads the in-process counter of the connector seam; a test injects its own,
   * so no test depends on another test's reads.
   */
  chatIngress?: (() => ChannelIngressCounters) | null;

  /** myrmidon(1.6.6 TMP-HYGIENE): where the run scratch volume comes from; tests inject a fake. */
  runScratch?: (() => HeartbeatRunScratchMetrics) | null;

  /** myrmidon(1.6.6 REMOTE-SITES-T4): where the remote-site metrics come from; tests inject a fake. */
  fleetSites?: (() => FleetSiteMetricsSample) | null;
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

/**
 * myrmidon(1.6.6-CORPUS-SHADOW A): p50/p95 of one shadow leg, in seconds,
 * over corpus_shadow_log rows written inside the latency window. The empty
 * table (flag off, the default) yields nulls — the families then render
 * HELP/TYPE without samples.
 */
async function readCorpusShadowLatencies(
  db: Db,
  windowStart: Date,
): Promise<{
  ragflow: { p50: number | null; p95: number | null };
  module: { p50: number | null; p95: number | null };
}> {
  const rows = await db
    .select({
      ragflowMs: corpusShadowLog.ragflowLatencyMs,
      moduleMs: corpusShadowLog.moduleLatencyMs,
    })
    .from(corpusShadowLog)
    .where(gte(corpusShadowLog.ts, windowStart))
    .orderBy(corpusShadowLog.ts)
    .limit(LATENCY_SAMPLE_CAP);
  type ShadowRow = { ragflowMs: number | null; moduleMs: number | null };
  const toSeconds = (values: ShadowRow[], field: keyof ShadowRow) =>
    values
      .map((row) => row[field])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
      .map((value) => value / 1000);
  const ragflow = toSeconds(rows, "ragflowMs").sort((a, b) => a - b);
  const module = toSeconds(rows, "moduleMs").sort((a, b) => a - b);
  return {
    ragflow: ragflow.length === 0 ? { p50: null, p95: null } : { p50: percentile(ragflow, 0.5), p95: percentile(ragflow, 0.95) },
    module: module.length === 0 ? { p50: null, p95: null } : { p50: percentile(module, 0.5), p95: percentile(module, 0.95) },
  };
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
    role: collected.role,
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
  /** myrmidon(1.6.6 OPE-6959): the resolved role this scrape renders as the `role` label. */
  role: string;
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
  const role = deps.role ?? resolveBoardProcessRole();
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

  const blocked = await guarded(
    "blocked_age_seconds|blocked_missing_fields_total",
    async () => {
      const rows = await deps.db.select({ id: companies.id }).from(companies);
      const result: NonNullable<MetricsSnapshotFields["blocked"]> = [];
      for (const company of rows) {
        const groups = await collectBlockedMetrics((id) => loadBlockedGraph(deps.db, id), company.id, now);
        result.push({ companyId: company.id, groups });
      }
      return result;
    },
    [] as NonNullable<MetricsSnapshotFields["blocked"]>,
  );

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
  // myrmidon(1.6.6-CORPUS-SHADOW A): both shadow legs ride the same guarded
  // scrape; the per-family "a|b" entry marks both families on a failed read,
  // which the self-check's split("|") already understands.
  const shadowLatencies = await guarded(
    "myrmidon_corpus_shadow_ragflow_latency_seconds|myrmidon_corpus_shadow_module_latency_seconds",
    () => readCorpusShadowLatencies(deps.db, latencyWindowStart),
    { ragflow: { p50: null, p95: null }, module: { p50: null, p95: null } },
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
  // and names the six families, never kills the scrape.
  const processSample = await guarded(
    "myrmidon_board_event_loop_lag_seconds|myrmidon_board_event_loop_utilization|myrmidon_board_process_rss_bytes|myrmidon_board_heap_bytes|myrmidon_board_live_events_total|myrmidon_board_live_event_bytes_total",
    () => Promise.resolve().then(resolveProcessMetricsSource(deps.processMetrics)),
    null as ProcessMetricsSample | null,
  );
  // myrmidon(1.6.6-PROCS-0.3A): the lane half rides the same guarded scrape —
  // a throwing source zeroes it and names the two families, never kills the
  // scrape. The registry itself cannot throw; the guard is here for the seam.
  const laneSample = await guarded(
    "myrmidon_board_db_queries_total|myrmidon_board_lane_busy_seconds_total",
    () => Promise.resolve().then(resolveLaneMetricsSource(deps.laneMetrics)),
    null as BoardLaneSample[] | null,
  );

  // myrmidon(1.6.6-CH-CONNECTOR-G): the fallback counters of the bridge seam
  // ride the same guarded scrape. The registry cannot throw; the guard is here
  // for the seam, the way it is for the lanes.
  const singletonProxySample = await guarded(
    "myrmidon_board_singleton_proxy_total",
    () => Promise.resolve().then(resolveSingletonProxySource(deps.singletonProxy)),
    null as SingletonProxySample[] | null,
  );
  const fallbackSample = await guarded(
    "myrmidon_adapter_fallback_total",
    () => Promise.resolve().then(resolveChannelBridgeFallbackSource(deps.adapterFallbacks)),
    null as ChannelBridgeFallbackSample[] | null,
  );

  // myrmidon(1.6.6 CONNECTOR-IN): the ingress half rides the same guarded
  // scrape: an in-process counter that cannot throw today, guarded anyway so a
  // future source cannot kill the scrape — it names its family instead.
  const chatIngress = await guarded(
    "myrmidon_chat_ingress_total",
    () => Promise.resolve().then(() => (deps.chatIngress ?? channelIngressCounters)()),
    null as ChannelIngressCounters | null,
  );

  // myrmidon(1.6.6 TMP-HYGIENE): the run scratch volume rides the same guarded scrape.
  const runScratch = await guarded(
    "myrmidon_run_scratch_removed_dirs_total|myrmidon_run_scratch_removed_bytes_total|myrmidon_run_scratch_remaining_dirs|myrmidon_run_scratch_remaining_bytes",
    () => Promise.resolve().then(() => (deps.runScratch ?? heartbeatRunScratchMetrics)()),
    null as HeartbeatRunScratchMetrics | null,
  );

  // myrmidon(1.6.6 REMOTE-SITES-T4): the remote-site state rides the same guarded scrape.
  const fleetSites = await guarded(
    "myrmidon_fleet_site_reachable|myrmidon_fleet_site_last_seen_seconds|myrmidon_fleet_exec_retries_total|myrmidon_fleet_moves_total",
    () => Promise.resolve().then(() => (deps.fleetSites ?? readFleetSiteMetrics)()),
    null as FleetSiteMetricsSample | null,
  );

  return {
    fields: {
      blocked,
      runsActive: runCounters.active,
      runsQueued: runCounters.queued,
      runsFailedTotal: runCounters.failedTotal,
      runsFailedWindow: failedWindow,
      runDurationSecondsP50: durations.p50,
      runDurationSecondsP95: durations.p95,
      corpusShadowRagflowSecondsP50: shadowLatencies.ragflow.p50,
      corpusShadowRagflowSecondsP95: shadowLatencies.ragflow.p95,
      corpusShadowModuleSecondsP50: shadowLatencies.module.p50,
      corpusShadowModuleSecondsP95: shadowLatencies.module.p95,
      roleQueueTasks: roleQueues,
      swarmClaimsActive: claimCounters.active,
      swarmClaimsTotal: claimCounters.total,
      agentErrorSignals: errorSignals,
      llmCostCentsWindow: costWindow,
      process: processSample,
      lanes: laneSample,

      adapterFallbacks: fallbackSample,
      singletonProxy: singletonProxySample,

      chatIngress,

      runScratch,

      fleetSites,
      blockerRoots: await guarded(
        "blocker_root_fanout|blocker_terminal_count|blocker_roots_over_limit",
        () => collectBlockerRootMetrics(deps.db),
        null as BlockerRootMetrics | null,
      ),
    },
    errors,
    now,
    latencySamples: durations.samples,
    role,
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
      role: collected.role,
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
 *
 * myrmidon(1.6.6 OPE-6959): every sample carries the process `role` label
 * (api | worker | all). Metric names do not change — only the label set
 * grows, so a multi-process deployment (design BOARD-PROCESSES этап 1) can
 * tell the api processes from the worker without scrape-config relabeling.
 * The role goes FIRST in the label set so a future group_left join reads
 * naturally: `{role="api",quantile="0.5"}`.
 */
export function renderMetricsText(snapshot: MetricsSnapshot): string {
  const role = snapshot.role ?? "all";
  const R = `role="${escapeLabelValue(role)}"`;
  const blocks: string[] = [];

  const blockedAgeSamples: string[] = [];
  const blockedMissingFieldsSamples: string[] = [];
  for (const { companyId, groups } of snapshot.blocked ?? []) {
    const C = companyId ? `,company_id="${escapeLabelValue(companyId)}"` : "";
    for (const group of groups) {
      for (const statistic of ["p50", "p95", "max"] as const) {
        const value = group.ageSeconds[statistic];
        if (value !== null) {
          blockedAgeSamples.push(
            `blocked_age_seconds{${R}${C},legacy="${group.legacy}",statistic="${statistic}"} ${formatSampleValue(value)}`,
          );
        }
      }
      for (const field of ["reason", "owner", "nextCheckAt"] as const) {
        blockedMissingFieldsSamples.push(
          `blocked_missing_fields_total{${R}${C},legacy="${group.legacy}",field="${field}"} ${formatSampleValue(group.missingFields[field])}`,
        );
      }
    }
  }

  blocks.push(
    familyBlock(
      "blocked_age_seconds",
      "Current blocked age in seconds (nearest-rank percentiles).",
      "gauge",
      blockedAgeSamples,
    ),
  );
  blocks.push(
    familyBlock(
      "blocked_missing_fields_total",
      "Current blocked issues missing each required field.",
      "gauge",
      blockedMissingFieldsSamples,
    ),
  );

  blocks.push(
    familyBlock(
      "myrmidon_runs_active",
      "Heartbeat runs currently running or claimed.",
      "gauge",
      [`myrmidon_runs_active{${R}} ${formatSampleValue(snapshot.runsActive)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_runs_queued",
      "Heartbeat runs waiting for admission (queued, retrying, scheduled_retry).",
      "gauge",
      [`myrmidon_runs_queued{${R}} ${formatSampleValue(snapshot.runsQueued)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_runs_failed_total",
      "Heartbeat runs with status failed, all time.",
      "gauge",
      [`myrmidon_runs_failed_total{${R}} ${formatSampleValue(snapshot.runsFailedTotal)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_runs_failed_window",
      "Failed heartbeat runs inside the scrape error window.",
      "gauge",
      [`myrmidon_runs_failed_window{${R}} ${formatSampleValue(snapshot.runsFailedWindow)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_run_duration_seconds",
      "Run duration quantiles (finishedAt - startedAt) over the latency window.",
      "summary",
      [
        ...(snapshot.runDurationSecondsP50 !== null
          ? [`myrmidon_run_duration_seconds{${R},quantile="0.5"} ${formatSampleValue(snapshot.runDurationSecondsP50)}`]
          : []),
        ...(snapshot.runDurationSecondsP95 !== null
          ? [`myrmidon_run_duration_seconds{${R},quantile="0.95"} ${formatSampleValue(snapshot.runDurationSecondsP95)}`]
          : []),
      ],
    ),
  );
  // myrmidon(1.6.6-CORPUS-SHADOW A): the two shadow legs, one summary each,
  // same quantile shape as the run-duration family above.
  blocks.push(
    familyBlock(
      "myrmidon_corpus_shadow_ragflow_latency_seconds",
      "Corpus shadow log: RAGFlow leg latency quantiles over the latency window.",
      "summary",
      [
        ...(snapshot.corpusShadowRagflowSecondsP50 != null
          ? [`myrmidon_corpus_shadow_ragflow_latency_seconds{quantile=\"0.5\"} ${formatSampleValue(snapshot.corpusShadowRagflowSecondsP50)}`]
          : []),
        ...(snapshot.corpusShadowRagflowSecondsP95 != null
          ? [`myrmidon_corpus_shadow_ragflow_latency_seconds{quantile=\"0.95\"} ${formatSampleValue(snapshot.corpusShadowRagflowSecondsP95)}`]
          : []),
      ],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_corpus_shadow_module_latency_seconds",
      "Corpus shadow log: corpus-module leg latency quantiles over the latency window.",
      "summary",
      [
        ...(snapshot.corpusShadowModuleSecondsP50 != null
          ? [`myrmidon_corpus_shadow_module_latency_seconds{quantile=\"0.5\"} ${formatSampleValue(snapshot.corpusShadowModuleSecondsP50)}`]
          : []),
        ...(snapshot.corpusShadowModuleSecondsP95 != null
          ? [`myrmidon_corpus_shadow_module_latency_seconds{quantile=\"0.95\"} ${formatSampleValue(snapshot.corpusShadowModuleSecondsP95)}`]
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
          `myrmidon_role_queue_tasks{${R},assignee_role="${escapeLabelValue(row.role)}",status="${escapeLabelValue(row.status)}"} ${formatSampleValue(row.count)}`,
      ),
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_swarm_claims_active",
      "Live (not released, not expired) SWARM claims.",
      "gauge",
      [`myrmidon_swarm_claims_active{${R}} ${formatSampleValue(snapshot.swarmClaimsActive)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_swarm_claims_total",
      "SWARM claim rows ever written (issue_claims rows).",
      "counter",
      [`myrmidon_swarm_claims_total{${R}} ${formatSampleValue(snapshot.swarmClaimsTotal)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_agent_error_signals",
      "Live agent error signals in the attention registries (tracing health, stale blocks, swarm claims).",
      "gauge",
      [`myrmidon_agent_error_signals{${R}} ${formatSampleValue(snapshot.agentErrorSignals)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_llm_cost_cents_total",
      "LLM spend collected by the gateway cost sweep inside the scrape window, in cents.",
      "counter",
      [`myrmidon_llm_cost_cents_total{${R}} ${formatSampleValue(snapshot.llmCostCentsWindow)}`],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_scrape_errors",
      "Metric families that failed to collect during this scrape.",
      "gauge",
      [`myrmidon_scrape_errors{${R}} ${formatSampleValue(snapshot.scrapeErrors)}`],
    ),
  );

  const claimCounters = swarmClaimMetrics.read();
  blocks.push(
    familyBlock(
      "swarm_claim_conflicts_total",
      "Claim attempts refused because a live claim exists, cumulative since process start.",
      "counter",
      [`swarm_claim_conflicts_total{${R}} ${formatSampleValue(claimCounters.conflicts)}`],
    ),
    familyBlock(
      "swarm_lease_recovered_total",
      "Leases successfully recovered by expiry or supervisor rebalance, cumulative since process start.",
      "counter",
      SWARM_LEASE_RECOVERY_REASONS.map((reason) =>
        `swarm_lease_recovered_total{${R},reason="${reason}"} ${formatSampleValue(claimCounters.recovered[reason])}`,
      ),
    ),
  );
  const continuationCounters = continuationDedupeMetrics.read();
  blocks.push(
    familyBlock(
      "myrmidon_continuation_created_total",
      "Continuation keys claimed for the first time since this process started.",
      "counter",
      [`myrmidon_continuation_created_total{${R}} ${formatSampleValue(continuationCounters.created)}`],
    ),
    familyBlock(
      "myrmidon_continuation_deduped_total",
      "Continuation keys suppressed because they were already claimed, cumulative since process start.",
      "counter",
      [`myrmidon_continuation_deduped_total{${R}} ${formatSampleValue(continuationCounters.deduped)}`],
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
            `myrmidon_board_event_loop_lag_seconds{${R},quantile="0.5"} ${formatSampleValue(proc.eventLoop.p50Seconds)}`,
            `myrmidon_board_event_loop_lag_seconds{${R},quantile="0.99"} ${formatSampleValue(proc.eventLoop.p99Seconds)}`,
            `myrmidon_board_event_loop_lag_seconds{${R},quantile="1"} ${formatSampleValue(proc.eventLoop.maxSeconds)}`,
          ]
        : [],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_board_event_loop_utilization",
      "Share of the event loop window the board process was busy (0..1) since the previous scrape.",
      "gauge",
      proc && proc.eventLoopUtilization
        ? [
            `myrmidon_board_event_loop_utilization{${R}} ${formatSampleValue(proc.eventLoopUtilization.utilization)}`,
          ]
        : [],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_board_process_rss_bytes",
      "Resident set size of the board process.",
      "gauge",
      proc ? [`myrmidon_board_process_rss_bytes{${R}} ${formatSampleValue(proc.memory.rssBytes)}`] : [],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_board_heap_bytes",
      "V8 heap of the board process by kind label (used / total).",
      "gauge",
      proc
        ? [
            `myrmidon_board_heap_bytes{${R},kind="used"} ${formatSampleValue(proc.memory.heapUsedBytes)}`,
            `myrmidon_board_heap_bytes{${R},kind="total"} ${formatSampleValue(proc.memory.heapTotalBytes)}`,
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
              `myrmidon_board_live_events_total{${R},kind="${escapeLabelValue(row.type)}"} ${formatSampleValue(row.count)}`,
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
              `myrmidon_board_live_event_bytes_total{${R},kind="${escapeLabelValue(row.type)}"} ${formatSampleValue(row.bytes)}`,
          )
        : [],
    ),
  );

  // myrmidon(1.6.6-PROCS-0.3A): the load lanes. Every lane renders even at
  // zero — a lane that never ran is information ("this work does not happen
  // on this process"), and a missing series would be indistinguishable from
  // an uninstrumented one. The DB family carries no `lane` label of its own
  // (`untagged` is the residue, not a lane).
  const lanes = snapshot.lanes ?? null;
  blocks.push(
    familyBlock(
      "myrmidon_board_db_queries_total",
      "DB statements issued by the board process per load lane, cumulative since boot (work outside every lane is counted as untagged; statements inside a transaction are not counted by the driver observer).",
      "counter",
      lanes
        ? lanes.map(
            (row) =>
              `myrmidon_board_db_queries_total{${R},lane="${escapeLabelValue(row.lane)}"} ${formatSampleValue(row.dbQueries)}`,
          )
        : [],
    ),
  );
  blocks.push(
    familyBlock(
      "myrmidon_board_lane_busy_seconds_total",
      "Wall time the board process spent inside each load lane, cumulative since boot (seconds).",
      "counter",
      lanes
        ? lanes.map(
            (row) =>
              `myrmidon_board_lane_busy_seconds_total{${R},lane="${escapeLabelValue(row.lane)}"} ${formatSampleValue(row.busyMs / 1000)}`,
          )
        : [],
    ),
  );

  // myrmidon(1.6.6 PROCS-1.5 / OPE-5412): the single-route proxy. Every route
  // group x outcome renders even at zero — on a single-process board the whole
  // family is zero, and a missing series would hide an unwired counter.
  const proxyRows = snapshot.singletonProxy ?? null;
  blocks.push(
    familyBlock(
      "myrmidon_board_singleton_proxy_total",
      "Single-process routes an api process forwarded to the worker, per route group and outcome (proxied or unavailable), cumulative since boot.",
      "counter",
      proxyRows
        ? proxyRows.map(
            (row) =>
              `myrmidon_board_singleton_proxy_total{${R},route="${escapeLabelValue(row.route)}",outcome="${escapeLabelValue(row.outcome)}"} ${formatSampleValue(row.count)}`,
          )
        : [],
    ),
  );

  // myrmidon(1.6.6-CH-CONNECTOR-G): the fallback chain of the bridge seam. Both
  // reasons render even at zero — "the adapter never fell back" is exactly what
  // an operator looks for after a rollout, and a missing series would hide an
  // unwired counter instead of reporting it.
  const fallbacks = snapshot.adapterFallbacks ?? null;
  blocks.push(
    familyBlock(
      "myrmidon_adapter_fallback_total",
      "Bridge adapter calls that did not answer and were served by the direct path instead, per reason, cumulative since boot.",
      "counter",
      fallbacks
        ? fallbacks.map(
            (row) =>
              `myrmidon_adapter_fallback_total{reason="${escapeLabelValue(row.reason)}"} ${formatSampleValue(row.count)}`,
          )
        : [],
    ),
  );

  // myrmidon(1.6.6 CONNECTOR-IN): the inbound reads of the channel connectors.
  // Both paths render as samples whenever the counter was read, zero included:
  // "all ingress is read by the vendor path because no connector is registered
  // yet" is information, and a missing series would be indistinguishable from
  // an uninstrumented read.
  const ingress = snapshot.chatIngress ?? null;
  blocks.push(
    familyBlock(
      "myrmidon_chat_ingress_total",
      "Inbound chat events read per path, cumulative since boot: read by the channel connector of the provider (adapter) or by the vendor path (direct).",
      "counter",
      ingress
        ? [
            `myrmidon_chat_ingress_total{path="adapter"} ${formatSampleValue(ingress.adapter)}`,
            `myrmidon_chat_ingress_total{path="direct"} ${formatSampleValue(ingress.direct)}`,
          ]
        : [],
    ),
  );

  // myrmidon(1.6.6 TMP-HYGIENE): the volume of the run scratch janitor. Rendered
  // as samples whenever the state was read, zero included.
  const scratch = snapshot.runScratch ?? null;
  const scratchFamily = (
    name: string,
    help: string,
    type: "gauge" | "counter",
    value: number | null,
  ) => blocks.push(familyBlock(name, help, type, value === null ? [] : [`${name} ${formatSampleValue(value)}`]));
  scratchFamily(
    "myrmidon_run_scratch_removed_dirs_total",
    "Orphaned heartbeat run scratch directories removed by the janitor, cumulative since boot of this process.",
    "counter",
    scratch ? scratch.removedDirsTotal : null,
  );
  scratchFamily(
    "myrmidon_run_scratch_removed_bytes_total",
    "Bytes freed by removing orphaned heartbeat run scratch directories, cumulative since boot of this process.",
    "counter",
    scratch ? scratch.removedBytesTotal : null,
  );
  scratchFamily(
    "myrmidon_run_scratch_remaining_dirs",
    "Marked heartbeat run scratch directories left after the last janitor sweep (not yet past TTL).",
    "gauge",
    scratch ? scratch.remainingDirs : null,
  );
  scratchFamily(
    "myrmidon_run_scratch_remaining_bytes",
    "Bytes held by marked heartbeat run scratch directories after the last janitor sweep.",
    "gauge",
    scratch ? scratch.remainingBytes : null,
  );

  // myrmidon(1.6.6 REMOTE-SITES-T4): the remote sites. A site renders from its first probe on;
  // every move result renders at zero too.
  const fleet = snapshot.fleetSites ?? null;
  blocks.push(
    familyBlock(
      "myrmidon_fleet_site_reachable",
      "1 when the last health probe of the remote site answered, 0 when it did not.",
      "gauge",
      fleet ? fleet.sites.map((row) => `myrmidon_fleet_site_reachable{site="${escapeLabelValue(row.site)}"} ${row.reachable}`) : [],
    ),
    familyBlock(
      "myrmidon_fleet_site_last_seen_seconds",
      "Seconds since the remote site last answered a health probe (absent while it has never answered).",
      "gauge",
      fleet
        ? fleet.sites.flatMap((row) =>
            row.lastSeenSeconds === null
              ? []
              : [`myrmidon_fleet_site_last_seen_seconds{site="${escapeLabelValue(row.site)}"} ${formatSampleValue(row.lastSeenSeconds)}`],
          )
        : [],
    ),
    familyBlock(
      "myrmidon_fleet_exec_retries_total",
      "Runs of a lost remote site finalized as site_lost and requeued, per site, cumulative since boot.",
      "counter",
      fleet ? fleet.retriesTotal.map((row) => `myrmidon_fleet_exec_retries_total{site="${escapeLabelValue(row.site)}"} ${formatSampleValue(row.count)}`) : [],
    ),
    familyBlock(
      "myrmidon_fleet_moves_total",
      "Failover moves of bots off a lost remote site by result, cumulative since boot.",
      "counter",
      fleet ? fleet.movesTotal.map((row) => `myrmidon_fleet_moves_total{result="${escapeLabelValue(row.result)}"} ${formatSampleValue(row.count)}`) : [],
    ),
  );

  blocks.push(renderBlockerRootMetrics(snapshot.blockerRoots ?? { companies: [] }).trimEnd());
  return `${blocks.join("\n\n")}\n`;
}
