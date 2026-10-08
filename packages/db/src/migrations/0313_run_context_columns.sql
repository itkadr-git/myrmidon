-- Catalog-only change: the columns are nullable without a default, so no table
-- rewrite. Historical rows are filled by the batched background job
-- server/src/services/run-context-columns-backfill.ts (commit per batch); until
-- then the readers fall back to context_snapshot via coalesce.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_issue_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_task_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_task_key" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_comment_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_comment_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_source" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_trigger_detail" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_run_summary" text;
