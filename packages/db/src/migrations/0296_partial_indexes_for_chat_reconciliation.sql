-- Indexes for the chat reconciliation sweeps, which now run on events plus a rare
-- fallback pass and look for pending/retry work.
--
-- These are NOT CREATE INDEX CONCURRENTLY: migrations run inside a transaction,
-- where CONCURRENTLY is rejected. On a large live table build them by hand with
-- CONCURRENTLY first (same names; IF NOT EXISTS makes this migration a no-op
-- afterwards) or accept the build-time lock in a low-traffic window.

CREATE INDEX IF NOT EXISTS "chat_publications_work_pending_retry_idx" ON "chat_publications" USING btree ("state","next_attempt_at") WHERE "state" in ('pending', 'retry', 'streaming');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_actions_work_pending_retry_idx" ON "chat_actions" USING btree ("status","created_at","id") WHERE "status" in ('received', 'processing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_updated_idx" ON "heartbeat_runs" USING btree ("company_id","status","updated_at");
