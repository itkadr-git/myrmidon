-- myrmidon(1.7 data-retention): indexes for the FK-safe prune in
-- server/src/myrmidon/data-retention/sweep.ts. The wakeup-request delete skips
-- rows that a heartbeat run still names (heartbeat_runs.wakeup_request_id, a
-- no-action FK); without these indexes that NOT EXISTS is a hash anti join
-- reading all of heartbeat_runs and agent_wakeup_requests for every batch.
-- The released-lease prune walks released_at the same way.
-- A migration cannot use CONCURRENTLY (it runs in a transaction). On production
-- create each index by hand with CREATE INDEX CONCURRENTLY under the same name
-- first; IF NOT EXISTS then makes this migration a no-op.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; production pre-creates the index concurrently under the same name.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_terminal_finished_idx" ON "agent_wakeup_requests" USING btree ("finished_at") WHERE "agent_wakeup_requests"."status" in ('skipped', 'failed', 'cancelled', 'completed', 'coalesced');--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; production pre-creates the index concurrently under the same name.
CREATE INDEX IF NOT EXISTS "environment_leases_released_prune_idx" ON "environment_leases" USING btree ("released_at") WHERE "environment_leases"."status" = 'released';--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; production pre-creates the index concurrently under the same name.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_wakeup_request_id_idx" ON "heartbeat_runs" USING btree ("wakeup_request_id");
