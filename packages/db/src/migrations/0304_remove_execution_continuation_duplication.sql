-- PERF-DIET: heartbeat_runs.context_snapshot stored the execution continuation
-- envelope twice: once at the top level and once inside paperclipWake. The wake
-- payload is the canonical copy (readers go through readExecutionContinuation in
-- server/src/services/execution-continuation.ts), so the top-level key is dead
-- weight of roughly one envelope per run.
--
-- Two properties matter for production:
--   1. No data may be lost. A row whose wake payload does not carry the envelope
--      gets the top-level copy moved into paperclipWake before the key is
--      stripped; rows that already carry both copies only lose the duplicate.
--   2. The table holds about a gigabyte of TOASTed JSON, so the rewrite walks the
--      primary key once in bounded batches instead of one table-wide UPDATE.
--      Rows are addressed by an id range, which keeps each batch bounded without
--      re-reading everything already processed. The statement is idempotent:
--      re-running it after a partial application only touches leftover rows.
DO $$
DECLARE
  batch_size constant integer := 200;
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  batch_max_id uuid;
  batch_rows integer;
BEGIN
  LOOP
    SELECT count(*), (array_agg(id ORDER BY id DESC))[1]
    INTO batch_rows, batch_max_id
    FROM (
      SELECT id
      FROM heartbeat_runs
      WHERE id > last_id
        AND context_snapshot ? 'executionContinuation'
      ORDER BY id
      LIMIT batch_size
    ) AS batch;

    EXIT WHEN batch_rows = 0;

    UPDATE heartbeat_runs AS run
    SET context_snapshot = CASE
      WHEN jsonb_typeof(run.context_snapshot -> 'paperclipWake') = 'object'
        AND NOT (run.context_snapshot -> 'paperclipWake' ? 'executionContinuation')
      THEN jsonb_set(
        run.context_snapshot,
        '{paperclipWake,executionContinuation}',
        run.context_snapshot -> 'executionContinuation'
      ) - 'executionContinuation'
      ELSE run.context_snapshot - 'executionContinuation'
    END
    WHERE run.id > last_id
      AND run.id <= batch_max_id
      AND run.context_snapshot ? 'executionContinuation';

    last_id := batch_max_id;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$$;