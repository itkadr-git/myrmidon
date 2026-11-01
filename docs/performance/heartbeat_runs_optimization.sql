-- Read-only measurements for heartbeat run storage. Run on a representative
-- database; EXPLAIN ANALYZE executes its SELECT and can consume resources.

-- 1. Current size of the run table, heap, and TOAST data.
SELECT
  pg_size_pretty(pg_total_relation_size('heartbeat_runs')) AS total_size,
  pg_size_pretty(pg_relation_size('heartbeat_runs')) AS heap_size,
  pg_size_pretty(pg_total_relation_size(reltoastrelid)) AS toast_size
FROM pg_class
WHERE oid = 'heartbeat_runs'::regclass;

-- 2. Snapshot size. Current writes omit executionContinuation from the
-- persisted context_snapshot; legacy rows may still have that field.
SELECT
  count(*) AS runs,
  pg_size_pretty(avg(pg_column_size(context_snapshot))::bigint) AS avg_context_snapshot,
  pg_size_pretty(max(pg_column_size(context_snapshot))::bigint) AS max_context_snapshot,
  count(*) FILTER (WHERE context_snapshot ? 'executionContinuation') AS legacy_snapshot_continuations
FROM heartbeat_runs;

-- 3. Dedicated continuation table size and row count.
SELECT
  count(*) AS continuations,
  pg_size_pretty(sum(pg_column_size(envelope))::bigint) AS envelope_payload_size,
  pg_size_pretty(avg(pg_column_size(envelope))::bigint) AS avg_envelope_payload
FROM heartbeat_run_continuations;

-- 4. Illustrative run-list projection. The current application reads thin
-- context columns first and falls back to snapshot JSON for historical rows;
-- this query shows the fallback extraction shape only. Compare with production
-- plans and representative parameters; the planner may choose another index.
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  id, status, started_at, finished_at, error,
  context_snapshot ->> 'issueId' AS context_issue_id,
  context_snapshot ->> 'wakeReason' AS context_wake_reason,
  left(result_json ->> 'summary', 400) AS result_summary
FROM heartbeat_runs
WHERE company_id = '00000000-0000-0000-0000-000000000000'
ORDER BY created_at DESC, id DESC
LIMIT 200;

-- 5. Conversation-ownership probe shape. This intentionally selects only the
-- six values used by the probe, not the full heartbeat_runs row.
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  id, agent_id, process_pid, process_group_id, process_started_at,
  EXISTS (
    SELECT 1 FROM environment_leases
    WHERE environment_leases.company_id = heartbeat_runs.company_id
      AND environment_leases.heartbeat_run_id = heartbeat_runs.id
      AND (environment_leases.released_at IS NULL
        OR environment_leases.status = 'pending_cleanup'
        OR environment_leases.cleanup_status = 'failed')
  ) AS active_lease
FROM heartbeat_runs
WHERE company_id = '00000000-0000-0000-0000-000000000000'
  AND runtime_mode = 'legacy'
  AND coalesce(native_issue_id::text, context_snapshot ->> 'issueId') = '00000000-0000-0000-0000-000000000000'
  AND status IN ('failed', 'timed_out', 'interrupted', 'cancelled')
  AND (process_pid IS NOT NULL OR process_group_id IS NOT NULL)
ORDER BY created_at DESC, id DESC;

-- 6. Issue lookup shape backed by heartbeat_runs_company_issue_coalesce_created_idx.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status, created_at
FROM heartbeat_runs
WHERE company_id = '00000000-0000-0000-0000-000000000000'
  AND coalesce(native_issue_id::text, context_snapshot ->> 'issueId') = '00000000-0000-0000-0000-000000000000'
ORDER BY created_at DESC, id DESC
LIMIT 200;

-- 7. One run: compare the legacy snapshot continuation with the dedicated
-- table row, if present. A missing legacy value is expected for current writes.
SELECT
  pg_size_pretty(pg_column_size(context_snapshot -> 'executionContinuation')) AS legacy_snapshot_payload,
  pg_size_pretty(pg_column_size(continuations.envelope)) AS dedicated_envelope_payload
FROM heartbeat_runs
LEFT JOIN heartbeat_run_continuations AS continuations
  ON continuations.run_id = heartbeat_runs.id
WHERE heartbeat_runs.id = '00000000-0000-0000-0000-000000000000';
