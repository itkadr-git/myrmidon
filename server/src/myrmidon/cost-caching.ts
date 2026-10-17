// server/src/myrmidon/cost-caching.ts
//
// myrmidon(1.2-COST-CACHING): measuring the idle-heartbeat skip and reusing
// the previous expensive answer when a wake reissues an identical prompt.
//
// Part A — idle-skip metrics (MYRMIDON_IDLE_SKIP_METRICS, off by default):
//   the wake-admission path in heartbeat.ts skips generic timer wakes of an
//   agent with no work (myrmidon(M3)). With the setting on, every such skip
//   additionally records one log line plus one process-wide counter step:
//   "how many empty wakes were skipped, how many model calls were saved"
//   (one skipped wake = one saved adapter invocation). Snapshot and reset
//   are exported for tests and for a future metrics endpoint.
//
// Part B — prompt cache by cost data (MYRMIDON_PROMPT_CACHE_MIN_COST, unset =
//   off): a generic timer wake whose context snapshot is IDENTICAL to the one
//   of the agent's previous finished run reuses that run's recorded answer
//   (summary, usage, cost, session pointers) instead of starting a new
//   adapter invocation — but only when the recorded answer cost at least the
//   configured threshold (USD; `costUsd`, falling back to
//   `cacheAdjustedCostUsd`). Cheap or free answers are always recomputed:
//   caching them saves nothing. The reuse never crosses agents, never
//   applies to wakes with a concrete reason (issue, comment, task — those
//   carry new input, so the prompt cannot be identical), and never skips the
//   vendor dedup/admission mechanics: the cached wake request lands as a
//   normal `skipped` row with reason `heartbeat.timer.cached_identical_prompt`,
//   so the audit trail shows exactly which run supplied the reused answer.
//
// The fingerprint hashes the canonicalized context snapshot (keys sorted,
// volatile fields `runId`/`requestId`/`wakeupRequestId` dropped) — the same
// fields the adapter renders the prompt from. The cache itself is not a
// stored lookup table: the "cache entry" is the previous finished run row,
// read at wake time; the answers never leave `heartbeat_runs`, nothing new
// is persisted.

import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const IDLE_SKIP_METRICS_ENV = "MYRMIDON_IDLE_SKIP_METRICS";
export const PROMPT_CACHE_MIN_COST_ENV = "MYRMIDON_PROMPT_CACHE_MIN_COST";

export function idleSkipMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[IDLE_SKIP_METRICS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface PromptCacheSettings {
  enabled: boolean;
  /** Minimum cost (USD) of the previous answer for it to be reused. */
  minCostUsd: number;
}

/**
 * Off unless the variable parses as a finite number > 0. A threshold of `0`
 * or a negative value disables the cache instead of caching everything:
 * "cache every identical prompt" is never the silent outcome of a typo.
 */
export function readPromptCacheSettings(env: NodeJS.ProcessEnv = process.env): PromptCacheSettings {
  const raw = env[PROMPT_CACHE_MIN_COST_ENV]?.trim();
  if (!raw) return { enabled: false, minCostUsd: 0 };
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return { enabled: false, minCostUsd: 0 };
  return { enabled: true, minCostUsd: value };
}

// ---------------------------------------------------------------------------
// Part A: idle-skip metrics
// ---------------------------------------------------------------------------

export interface IdleSkipMetrics {
  /** Skipped empty timer wakes since process start (or the last reset). */
  skippedIdleWakes: number;
  /** Model invocations the skips saved (1:1 with skippedIdleWakes today). */
  savedModelCalls: number;
  lastSkipAt: string | null;
}

const metrics: IdleSkipMetrics = {
  skippedIdleWakes: 0,
  savedModelCalls: 0,
  lastSkipAt: null,
};

export function getIdleSkipMetrics(): IdleSkipMetrics {
  return { ...metrics };
}

/** Test hook: clears the process-wide counters. */
export function resetIdleSkipMetrics(): void {
  metrics.skippedIdleWakes = 0;
  metrics.savedModelCalls = 0;
  metrics.lastSkipAt = null;
}

/**
 * Records one skipped empty timer wake: bumps the counters and writes one
 * info log line. Called from the wake-admission path only when the metrics
 * setting is on and the wake is about to be skipped as
 * `heartbeat.timer.no_actionable_work`; a logging failure must never break
 * the skip itself, so the caller wraps this in try/catch.
 */
export function recordIdleSkip(
  fields: { companyId: string; agentId: string },
  opts: { now?: Date } = {},
): void {
  metrics.skippedIdleWakes += 1;
  metrics.savedModelCalls += 1;
  const at = (opts.now ?? new Date()).toISOString();
  metrics.lastSkipAt = at;
  logger.info(
    {
      companyId: fields.companyId,
      agentId: fields.agentId,
      skippedIdleWakes: metrics.skippedIdleWakes,
      savedModelCalls: metrics.savedModelCalls,
    },
    "idle heartbeat skipped: empty timer wake, model call saved",
  );
}

// ---------------------------------------------------------------------------
// Part B: prompt cache by cost data
// ---------------------------------------------------------------------------

/**
 * Fields that differ between two wakes whose rendered prompt is identical.
 * `runId`/`requestId`/`wakeupRequestId` are stamped by the admission path and
 * carry no prompt content. The scheduler's tick stamps `now` with the tick
 * timestamp; no adapter renders `context.now` into the prompt (verified
 * against every adapter package at the time of this feature: the templates
 * interpolate only agent/task/wake fields), so it is volatile too. A future
 * adapter that renders the clock into the prompt must remove `now` here —
 * the cache would otherwise return an answer written for a different time.
 */
const VOLATILE_SNAPSHOT_KEYS = new Set([
  "runId",
  "requestId",
  "wakeupRequestId",
  "now",
]);

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !VOLATILE_SNAPSHOT_KEYS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalize(v)}`).join(",")}}`;
}

/**
 * Stable fingerprint of the wake context the adapter renders the prompt
 * from. Two wakes with the same fingerprint produce the same prompt.
 */
export function fingerprintWakeContext(contextSnapshot: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(contextSnapshot)).digest("hex");
}

export interface CachedPromptAnswer {
  runId: string;
  finishedAt: Date | null;
  costUsd: number;
  /** The reused payload: summary + usage/cost fields of the run. */
  summary: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  sessionId: string | null;
  sessionDisplayId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readRecordedCostUsd(usageJson: Record<string, unknown> | null): number | null {
  if (!usageJson) return null;
  for (const key of ["costUsd", "cacheAdjustedCostUsd"]) {
    const value = usageJson[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Looks up the agent's newest finished run whose context snapshot has the
 * same fingerprint, and returns its recorded answer when its cost meets the
 * threshold. Returns null when there is no such run, when the cost is below
 * the threshold, or when the recorded row has nothing reusable (no summary
 * and no usage — a failed or empty run must not become a cache entry).
 *
 * The query is a bounded read of the runs table (the agent's newest finished
 * runs, fingerprint compared in JS — the snapshots live in a jsonb column
 * with no canonical form to index; the window keeps the read cheap).
 */
export async function findReusablePromptAnswer(
  db: Db,
  opts: {
    agentId: string;
    companyId: string;
    fingerprint: string;
    minCostUsd: number;
    /** How many of the agent's newest finished runs to inspect. Default 10. */
    windowSize?: number;
  },
): Promise<CachedPromptAnswer | null> {
  const windowSize = Math.max(1, Math.min(opts.windowSize ?? 10, 50));
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      finishedAt: heartbeatRuns.finishedAt,
      status: heartbeatRuns.status,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      usageJson: heartbeatRuns.usageJson,
      resultJson: heartbeatRuns.resultJson,
      sessionIdBefore: heartbeatRuns.sessionIdBefore,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, opts.agentId),
        eq(heartbeatRuns.companyId, opts.companyId),
        isNotNull(heartbeatRuns.finishedAt),
        eq(heartbeatRuns.status, "succeeded"),
        isNotNull(heartbeatRuns.contextSnapshot),
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(windowSize);

  for (const row of rows) {
    const context = asRecord(row.contextSnapshot);
    if (!context) continue;
    if (fingerprintWakeContext(context) !== opts.fingerprint) continue;
    const usageJson = asRecord(row.usageJson);
    const costUsd = readRecordedCostUsd(usageJson);
    if (costUsd == null || costUsd < opts.minCostUsd) continue;
    const resultJson = asRecord(row.resultJson);
    const summary =
      typeof resultJson?.summary === "string" && resultJson.summary.trim()
        ? resultJson.summary
        : null;
    if (!summary && !usageJson) continue;
    return {
      runId: row.id,
      finishedAt: row.finishedAt ?? null,
      costUsd,
      summary,
      usageJson,
      resultJson,
      sessionId: row.sessionIdAfter ?? null,
      sessionDisplayId:
        typeof usageJson?.persistedSessionId === "string"
          ? usageJson.persistedSessionId
          : null,
    };
  }
  return null;
}
