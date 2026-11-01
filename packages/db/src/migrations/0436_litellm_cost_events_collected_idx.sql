-- myrmidon(COSTS-STATS-INDEX / 1.6.6): cover the costs.stats latest-collected
-- lookup. The existing (company_id, occurred_at) index finds every matching
-- event but requires a heap fetch for collected_at across the whole lookback
-- window. INCLUDE makes that MAX probe eligible for an index-only scan.
--
-- Production rollout: create this index concurrently before deploying, then
-- remove the temporary ADM index in this migration. The migration runner is
-- transactional, so the migration itself cannot use CONCURRENTLY. This mirrors
-- the established large-table prebuild pattern in 0428:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "litellm_cost_events_company_occurred_collected_idx"
--     ON "litellm_cost_events" USING btree ("company_id","occurred_at") INCLUDE ("collected_at");
-- Verify the production EXPLAIN uses Index Only Scan and the pg_stat_statements
-- mean is below 0.5s before removing the temporary index during rollout.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; production builds the covering index concurrently before rollout, making the migration's create a no-op there.
CREATE INDEX IF NOT EXISTS "litellm_cost_events_company_occurred_collected_idx" ON "litellm_cost_events" USING btree ("company_id","occurred_at") INCLUDE ("collected_at");
--> statement-breakpoint
DROP INDEX IF EXISTS "adm_tmp_lce_company_occurred_collected";
