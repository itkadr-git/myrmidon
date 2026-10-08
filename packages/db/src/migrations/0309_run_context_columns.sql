ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_issue_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_task_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_task_key" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_comment_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_comment_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_source" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_trigger_detail" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_run_summary" text;--> statement-breakpoint
-- Backfill the thin columns from historical context_snapshot rows so the
-- coalesce readers get column hits without detoasting for every old run.
-- The primary-key cursor visits each row once; batches are bounded at 1000
-- IDs. The whole migration still runs inside one transaction, so locks last
-- until commit (same shape as 0265); the batch shape keeps per-statement work
-- and memory bounded on the live 1.5 GB table.
-- paperclip:migration-safety-ignore loop-mutation-large-table: Existing heartbeat_runs primary key supports the strictly advancing UUID cursor. Each batch selects at most 1000 IDs and updates only matching IDs whose thin columns are still NULL.
-- paperclip:migration-safety-ignore batched-mutation-large-table-missing-index: Existing heartbeat_runs primary key supports ORDER BY id and id > last_id. No JSON predicate is used to search repeatedly for the next batch.
DO $ctxcols$
DECLARE
  last_id uuid;
  batch_ids uuid[];
BEGIN
  LOOP
    IF last_id IS NULL THEN
      SELECT ARRAY(SELECT "id" FROM "heartbeat_runs" ORDER BY "id" LIMIT 1000) INTO batch_ids;
    ELSE
      SELECT ARRAY(SELECT "id" FROM "heartbeat_runs" WHERE "id" > last_id ORDER BY "id" LIMIT 1000) INTO batch_ids;
    END IF;
    EXIT WHEN cardinality(batch_ids) = 0;

    UPDATE "heartbeat_runs" AS run
    SET
      "context_issue_id" = NULLIF(run."context_snapshot" ->> 'issueId', ''),
      "context_task_id" = NULLIF(run."context_snapshot" ->> 'taskId', ''),
      "context_task_key" = NULLIF(run."context_snapshot" ->> 'taskKey', ''),
      "context_comment_id" = NULLIF(run."context_snapshot" ->> 'commentId', ''),
      "context_wake_comment_id" = NULLIF(run."context_snapshot" ->> 'wakeCommentId', ''),
      "context_wake_reason" = NULLIF(run."context_snapshot" ->> 'wakeReason', ''),
      "context_wake_source" = NULLIF(run."context_snapshot" ->> 'wakeSource', ''),
      "context_wake_trigger_detail" = NULLIF(run."context_snapshot" ->> 'wakeTriggerDetail', ''),
      "context_run_summary" = left(
        COALESCE(
          NULLIF(run."context_snapshot" ->> 'taskTitle', ''),
          NULLIF(run."context_snapshot" -> 'executionContinuation' ->> 'objective', '')
        ),
        512
      )
    WHERE run."id" = ANY(batch_ids)
      AND run."context_issue_id" IS NULL
      AND jsonb_typeof(run."context_snapshot") = 'object';

    -- batch_ids came back ORDER BY id, so its last element is the cursor head.
    -- (No max(uuid) aggregate exists in Postgres.)
    SELECT batch_ids[cardinality(batch_ids)] INTO last_id;
  END LOOP;
END
$ctxcols$;
