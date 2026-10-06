-- PERF-DIET measurement for heartbeat_runs (run on a copy of the board database
-- or inside the maintenance window; every statement is read-only).
--
-- 1. Leftover duplicates: how much the payload of the duplicated top-level
--    envelope costs. Run it before the dedupe migration; zero rows afterwards.
SELECT
  count(*)                                                       AS rows_with_top_level_copy,
  pg_size_pretty(sum(pg_column_size(context_snapshot -> 'executionContinuation'))) AS duplicate_payload,
  pg_size_pretty(sum(pg_column_size(context_snapshot -> 'paperclipWake')))         AS wake_payload
FROM heartbeat_runs
WHERE context_snapshot ? 'executionContinuation';

-- 2. Snapshot weight per run. The run list and the attention feed detoast this
--    column, so its average size drives both latencies.
SELECT
  count(*)                                     AS runs,
  pg_size_pretty(avg(pg_column_size(context_snapshot))::bigint) AS avg_context_snapshot,
  pg_size_pretty(max(pg_column_size(context_snapshot))::bigint) AS max_context_snapshot
FROM heartbeat_runs;

-- 3. Table and TOAST size before/after the migration.
SELECT
  pg_size_pretty(pg_total_relation_size('heartbeat_runs'))                       AS total,
  pg_size_pretty(pg_total_relation_size(reltoastrelid))                          AS toast,
  pg_size_pretty(pg_relation_size('heartbeat_runs'))                             AS heap
FROM pg_class
WHERE relname = 'heartbeat_runs';

-- 4. Run list projection (what GET /companies/:companyId/heartbeat-runs reads).
--    `heartbeat_runs_company_created_at_desc_idx` serves the company filter and
--    the order; the cost of the statement is the per-row detoast of
--    context_snapshot and result_json, which this projection keeps narrow.
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  id, status, started_at, finished_at, error,
  context_snapshot ->> 'issueId'      AS context_issue_id,
  context_snapshot ->> 'wakeReason'   AS context_wake_reason,
  left(result_json ->> 'summary', 400) AS result_summary
FROM heartbeat_runs
WHERE company_id = '00000000-0000-0000-0000-000000000000'
ORDER BY created_at DESC, id DESC
LIMIT 200;

-- 5. One run: the canonical copy of the continuation envelope, and the absence
--    of the duplicate top-level key after the migration.
SELECT
  pg_size_pretty(pg_column_size(context_snapshot -> 'paperclipWake'))         AS wake_payload,
  pg_size_pretty(pg_column_size(context_snapshot -> 'executionContinuation')) AS top_level_copy
FROM heartbeat_runs
WHERE id = '00000000-0000-0000-0000-000000000000';