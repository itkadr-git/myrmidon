-- Clean the historical duplicates of the executionContinuation envelope in
-- heartbeat_runs.context_snapshot.
--
-- Invariant (the run-context writer, buildPaperclipWakePayload): the canonical copy is
-- the top-level context_snapshot.executionContinuation; the nested copy
-- context_snapshot.paperclipWake.executionContinuation is a duplicate that new rows do
-- not carry. Readers: wakePayloadForDispatch (the top-level copy wins over the nested
-- one) and withoutDuplicateExecutionContinuation (run detail). This migration removes
-- the nested copy from the old rows and never touches the top-level one.
--
-- Three disjoint row classes, all selected by their JSON keys (never a bare scan):
--   1. top-level copy present AND nested copy present -> drop the nested copy;
--   2. top-level copy absent  AND nested copy is a JSON null -> drop the nested null;
--   3. top-level copy absent  AND nested copy is a value (an external adapter wrote the
--      envelope nested, under the old contract) -> lift it to the top level first, then
--      drop the nested copy. Without the lift the read path would go blind on such rows.
-- A JSON null counts as "absent" for the top-level copy.
--
-- Batched by primary-key ranges of 200 rows (a cursor on id, no OFFSET). Idempotent: a
-- second run matches no row and updates nothing.
--
-- Heavy: about 354 MB of duplicates on the production database (audit of 04.10). The
-- migration runs in one transaction, so apply it on production in the board operator's
-- maintenance window, not during a busy hour.
-- paperclip:migration-safety-ignore loop-mutation-large-table: the loop walks the primary key (id) in ranges of 200 rows and every UPDATE is limited by the id range and by the JSON keys of the duplicate.
-- paperclip:migration-safety-ignore batched-mutation-large-table-missing-index: the batch cursor is the primary key of heartbeat_runs, which is already indexed.
DO $$
DECLARE
  cursor_id uuid := NULL;
  batch_end uuid;
BEGIN
  LOOP
    SELECT max(batch.id) INTO batch_end
    FROM (
      SELECT "id"
      FROM "heartbeat_runs"
      WHERE cursor_id IS NULL OR "id" > cursor_id
      ORDER BY "id"
      LIMIT 200
    ) AS batch;
    EXIT WHEN batch_end IS NULL;

    -- Class 3 first: lift the nested envelope, then drop the nested copy.
    UPDATE "heartbeat_runs"
    SET "context_snapshot" = jsonb_set(
      jsonb_set(
        "context_snapshot",
        '{executionContinuation}',
        "context_snapshot" -> 'paperclipWake' -> 'executionContinuation'
      ),
      '{paperclipWake}',
      ("context_snapshot" -> 'paperclipWake') - 'executionContinuation'
    )
    WHERE ("id" > cursor_id OR cursor_id IS NULL)
      AND "id" <= batch_end
      AND jsonb_typeof("context_snapshot" -> 'paperclipWake') = 'object'
      AND coalesce(jsonb_typeof("context_snapshot" -> 'executionContinuation'), 'null') = 'null'
      AND coalesce(jsonb_typeof("context_snapshot" -> 'paperclipWake' -> 'executionContinuation'), 'null') <> 'null';

    -- Classes 1 and 2: the top-level copy is there (or the nested one is a JSON null).
    UPDATE "heartbeat_runs"
    SET "context_snapshot" = jsonb_set(
      "context_snapshot",
      '{paperclipWake}',
      ("context_snapshot" -> 'paperclipWake') - 'executionContinuation'
    )
    WHERE ("id" > cursor_id OR cursor_id IS NULL)
      AND "id" <= batch_end
      AND jsonb_typeof("context_snapshot" -> 'paperclipWake') = 'object'
      AND jsonb_typeof("context_snapshot" -> 'paperclipWake' -> 'executionContinuation') IS NOT NULL
      AND (
        coalesce(jsonb_typeof("context_snapshot" -> 'executionContinuation'), 'null') <> 'null'
        OR jsonb_typeof("context_snapshot" -> 'paperclipWake' -> 'executionContinuation') = 'null'
      );

    cursor_id := batch_end;
  END LOOP;
END
$$;
