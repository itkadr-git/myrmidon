import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { listAttentionExhaustedRuns } from "../services/attention-exhausted-runs.js";

// myrmidon(ATTENTION-PERF-PROOF) (OPE-5273, part B of OPE-5269):
// measurable proof that GET /api/companies/:id/attention answers < 2 s p95 at
// production volume. The live line boots an embedded Postgres, seeds
// ATTENTION_PERF_VOLUME heartbeat_runs rows with a realistic fat
// context_snapshot, captures EXPLAIN (ANALYZE, BUFFERS) plans for the two hot
// attention queries (listAttentionExhaustedRuns and the newerRuns window scan
// in attention.ts), then times attentionService.list() N times and fails when
// p95 >= 2000 ms.
//
// Env gate (same shape as docker/bot-runtime/g4-contract-check.sh +
// g4-contract.myrmidon.test.mjs): the static wiring checks below ALWAYS run,
// the live benchmark runs only when ATTENTION_PERF_CHECK=1, so plain CI and
// `pnpm test` environments skip it.
//
//   ATTENTION_PERF_CHECK=1                          enable the live line
//   ATTENTION_PERF_VOLUME=100000                    seeded heartbeat_runs rows
//   ATTENTION_PERF_SAMPLES=15                       timed list() calls
//   ATTENTION_PERF_WINDOW_DAYS=30                   age of the oldest unresolved failed run
//   ATTENTION_PERF_REPORT_DIR=/tmp                  write <dir>/attention-plans.txt / attention-perf.json

const perfEnabled = process.env.ATTENTION_PERF_CHECK === "1";

// Failure threshold from OPE-5269: the board must answer under 2 s at p95.
const P95_THRESHOLD_MS = 2_000;
// Default seeded volume from the OPE-5273 brief ("~100k heartbeat_runs").
const DEFAULT_VOLUME = 100_000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeLive = perfEnabled && embeddedPostgresSupport.supported ? describe : describe.skip;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return Number.NaN;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[idx];
}

function quoteLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;
  if (Array.isArray(value)) {
    return `array[${value.map((item) => quoteLiteral(item)).join(", ")}]${value.length === 0 ? "::text[]" : ""}`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Inline drizzle's positional `$n` params into the statement text so the same
// SQL can run under EXPLAIN (ANALYZE, BUFFERS) through db.execute(sql.raw(...)):
// EXPLAIN does not accept bind parameters, and sql.raw cannot carry any.
// Drizzle expands array predicates into individual `$n` placeholders, so a
// literal-per-placeholder substitution reproduces the exact bound statement.
function inlineParams(text: string, params: readonly unknown[]): string {
  return text.replace(/\$(\d+)/g, (_m, digits: string) => {
    const value = params[Number(digits) - 1];
    if (value === undefined) {
      throw new Error(`Missing bind parameter $${digits} for EXPLAIN statement`);
    }
    return quoteLiteral(value);
  });
}

describe("attention perf proof (static wiring)", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));

  it("service sources still expose the hot paths this harness measures", () => {
    // Guard against silent harness drift: if the exhaustion query stops reading the
    // thin run-context columns, the newer-run EXISTS check changes, or the exhaustion
    // event message changes, the seeded load no longer measures what ships — fail here.
    const exhaustedRuns = fs.readFileSync(
      path.join(HERE, "../services/attention-exhausted-runs.ts"),
      "utf8",
    );
    const attentionSource = fs.readFileSync(path.join(HERE, "../services/attention.ts"), "utf8");
    expect(exhaustedRuns).toMatch(/like 'Bounded retry exhausted%'/);
    expect(exhaustedRuns).toMatch(/heartbeatRuns\.contextIssueId/);
    expect(attentionSource).toMatch(/nr\.created_at > k\.created_at/);
    expect(attentionSource).toMatch(/->> 'issueId'/);
  });

  it("live line is env-gated and the threshold is pinned to the OPE-5269 criterion", () => {
    const source = fs.readFileSync(path.join(HERE, "attention-perf-proof.myrmidon.test.ts"), "utf8");
    expect(source).toMatch(/process\.env\.ATTENTION_PERF_CHECK === "1"/);
    expect(source).toMatch(/describeLive = perfEnabled && embeddedPostgresSupport\.supported/);
    expect(P95_THRESHOLD_MS).toBe(2_000);
    expect(envInt("ATTENTION_PERF_VOLUME", DEFAULT_VOLUME)).toBeGreaterThan(0);
  });
});

describeLive("attention perf proof (live, seeded production-volume load)", () => {
  const volume = envInt("ATTENTION_PERF_VOLUME", DEFAULT_VOLUME);
  const samples = envInt("ATTENTION_PERF_SAMPLES", 15);
  const windowDays = envInt("ATTENTION_PERF_WINDOW_DAYS", 30);
  const reportDir = process.env.ATTENTION_PERF_REPORT_DIR ?? "";

  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId = "";
  let agentIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-perf-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Perf Proof Co", issuePrefix: "PRF" });

    const agentCount = 24;
    agentIds = Array.from({ length: agentCount }, () => randomUUID());
    await db.insert(agents).values(
      agentIds.map((id, n) => ({
        id,
        companyId,
        name: `perf-agent-${n}`,
        role: "general",
        status: "active",
        adapterType: "hermes_gateway",
      })),
    );

    // Seed ~`volume` heartbeat_runs spread over the last `windowDays` days.
    // ~0.6 % of rows are failed/timed_out, with the OLDEST failed run pinned at
    // the start of the window: this reproduces the production symptom from
    // OPE-5269 — the newest unresolved failure is old, so the newerRuns window
    // (created_at > oldestFailedRunCreatedAt) spans the whole table.
    // context_snapshot is ~3-4 KB per row (issueId/taskId/taskKey/wakeReason
    // plus a fat continuation payload): large enough to force TOAST, matching
    // the production detoast cost the audit called out (no operator stats were
    // provided, so the size is justified by the TOAST threshold, not guessed at
    // production averages).
    await db.execute(sql.raw(`
      INSERT INTO heartbeat_runs (
        id, company_id, agent_id, invocation_source, status,
        error, error_code, started_at, finished_at,
        created_at, updated_at, context_snapshot
      )
      SELECT
        gen_random_uuid(),
        '${companyId}'::uuid,
        (ARRAY[${agentIds.map((id) => `'${id}'::uuid`).join(", ")}])[1 + (s % ${agentCount})],
        'on_demand',
        CASE
          WHEN s % 167 = 0 THEN 'failed'
          WHEN s % 211 = 0 THEN 'timed_out'
          ELSE 'completed'
        END,
        CASE WHEN s % 167 = 0 OR s % 211 = 0 THEN 'bounded retry window exceeded' ELSE NULL END,
        CASE WHEN s % 167 = 0 OR s % 211 = 0 THEN 'provider_error' ELSE NULL END,
        now() - (random() * ${windowDays} * interval '1 day'),
        now(),
        now() - (random() * ${windowDays} * interval '1 day'),
        now(),
        jsonb_build_object(
          'issueId', gen_random_uuid()::text,
          'taskId', gen_random_uuid()::text,
          'taskKey', 'perf-task-' || (s % 512),
          'wakeReason', CASE WHEN s % 7 = 0 THEN 'issue_commented' ELSE 'heartbeat' END,
          'wakeSource', 'routine',
          'executionContinuation', repeat('x', 3072)
        )
      FROM generate_series(1, ${volume}) AS s
    `));

    // Attach a bounded-retry-exhausted lifecycle event to every failed run so
    // listAttentionExhaustedRuns' inner join matches them (timed_out rows keep
    // no event: the join is part of what is being measured).
    await db.execute(sql.raw(`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, level, message, created_at)
      SELECT r.company_id, r.id, r.agent_id, 1, 'lifecycle', 'error',
             'Bounded retry exhausted after 3 scheduled attempts; no further automatic retry will be queued',
             r.created_at
      FROM heartbeat_runs r
      WHERE r.company_id = '${companyId}'::uuid AND r.status = 'failed'
    `));

    await db.execute(sql.raw(`ANALYZE heartbeat_runs`));
    await db.execute(sql.raw(`ANALYZE heartbeat_run_events`));
    await db.execute(sql.raw(`ANALYZE agents`));
  }, 600_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  }, 120_000);

  it(`captures EXPLAIN (ANALYZE, BUFFERS) plans and ${samples} timed attention list() calls at ${volume} rows`, async () => {
    const report: string[] = [];
    const emit = (line: string) => {
      report.push(line);
      console.log(line);
    };

    // ── Plan capture: the two hot attention queries ────────────────────────
    const exhaustedQuery = listAttentionExhaustedRuns(db, companyId);
    const exhaustedStmt = exhaustedQuery.toSQL();
    const exhaustedSqlText = inlineParams(exhaustedStmt.sql, exhaustedStmt.params as readonly unknown[]);
    const planA = await db.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) ${exhaustedSqlText}`));
    emit("=== EXPLAIN ANALYZE: listAttentionExhaustedRuns ===");
    emit((planA as unknown as Array<{ "QUERY PLAN"?: string }>).map((row) => row["QUERY PLAN"] ?? JSON.stringify(row)).join("\n"));

    // Pin the window to the OLDEST unresolved failed run (production symptom).
    // status='failed' only, matching prod: the newerRuns window derives from
    // exhaustion-event-bearing failed runs; timed_out rows without an event are
    // not in the window (OPE-5273 review non-blocker 2).
    const oldestRow = await db.execute(sql.raw(`
      SELECT min(created_at) AS oldest FROM heartbeat_runs
      WHERE company_id = '${companyId}'::uuid AND status = 'failed'
    `)) as unknown as Array<{ oldest: string | null }>;
    const oldestFailedRunCreatedAt = new Date(oldestRow[0]?.oldest ?? new Date(0));

    const failedAgentIds = agentIds;
    const newerRunsQuery = db
      .select({
        agentId: heartbeatRuns.agentId,
        createdAt: heartbeatRuns.createdAt,
        runIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
        runTaskId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.agentId, failedAgentIds),
        gt(heartbeatRuns.createdAt, oldestFailedRunCreatedAt),
      ));
    const newerStmt = newerRunsQuery.toSQL();
    const newerSqlText = inlineParams(newerStmt.sql, newerStmt.params as readonly unknown[]);
    const planB = await db.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) ${newerSqlText}`));
    emit("=== EXPLAIN ANALYZE: newerRuns window scan (attention.ts oldestFailedRunCreatedAt window) ===");
    emit((planB as unknown as Array<{ "QUERY PLAN"?: string }>).map((row) => row["QUERY PLAN"] ?? JSON.stringify(row)).join("\n"));

    // Timed raw runs of both hot queries (median + p95 of the query itself).
    const hotTimings = { exhausted: [] as number[], newer: [] as number[] };
    for (let i = 0; i < samples; i += 1) {
      let t0 = performance.now();
      await db.execute(sql.raw(exhaustedSqlText));
      hotTimings.exhausted.push(performance.now() - t0);
      t0 = performance.now();
      await db.execute(sql.raw(newerSqlText));
      hotTimings.newer.push(performance.now() - t0);
    }
    const fmt = (ms: number[]) => {
      const sorted = [...ms].sort((a, b) => a - b);
      return `p50=${percentile(sorted, 50).toFixed(0)}ms p95=${percentile(sorted, 95).toFixed(0)}ms max=${sorted[sorted.length - 1].toFixed(0)}ms`;
    };
    emit(`=== hot query timings (${samples} samples) ===`);
    emit(`listAttentionExhaustedRuns: ${fmt(hotTimings.exhausted)}`);
    emit(`newerRuns window scan:      ${fmt(hotTimings.newer)}`);

    // ── The route-level measurement: attentionService.list() ───────────────
    const svc = attentionService(db);
    const listTimings: number[] = [];
    let lastItemCount = 0;
    for (let i = 0; i < samples; i += 1) {
      const t0 = performance.now();
      const feed = await svc.list(companyId, { userId: "board-user" });
      listTimings.push(performance.now() - t0);
      lastItemCount = feed.items?.length ?? 0;
    }
    const sortedList = [...listTimings].sort((a, b) => a - b);
    const p50 = percentile(sortedList, 50);
    const p95 = percentile(sortedList, 95);
    emit(`=== attention list() (${samples} samples, volume=${volume}, windowDays=${windowDays}) ===`);
    emit(`feed items: ${lastItemCount}`);
    emit(`p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms max=${sortedList[sortedList.length - 1].toFixed(0)}ms`);
    emit(`all samples: ${listTimings.map((ms) => ms.toFixed(0)).join(", ")} ms`);

    if (reportDir) {
      fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(path.join(reportDir, "attention-plans.txt"), report.join("\n"));
      fs.writeFileSync(
        path.join(reportDir, "attention-perf.json"),
        JSON.stringify({ volume, windowDays, samples, p50Ms: p50, p95Ms: p95, listMs: listTimings, thresholdMs: P95_THRESHOLD_MS }, null, 2),
      );
    }

    expect(p95).toBeLessThan(P95_THRESHOLD_MS);
  }, 1_800_000);
});
