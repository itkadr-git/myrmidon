-- 0483: 1.7 DB-AUDIT (OPE-13055): drop three unused indexes on secret_access_events.
--
-- Continuation of 0477_drop_unused_indexes (OPE-12580). Code-reference analysis
-- (13.11.2026) over server/src: secret_access_events is queried only by
-- (company_id) + created_at window (attention feed), (company_id, secret_id)
-- ordered by created_at (listAccessEvents) and by retention DELETE on created_at.
-- The three indexes below are never referenced by any query shape:
--   - secret_access_events_consumer_idx (company_id, consumer_type, consumer_id)
--   - secret_access_events_run_idx (heartbeat_run_id)
--   - secret_access_events_user_definition_created_idx (user_secret_definition_id, created_at)
-- The 1.6.8 db-audit counted 658 unused indexes of 1208 (54.5%, 410 MiB); these
-- three carried writes-only cost on the hottest audit-log table (1.5-3.6M rows/day
-- before the OPE-12890 fix).
--
-- Kept (used by prod queries): secret_access_events_company_created_idx,
-- secret_access_events_secret_created_idx.
-- Note: a fourth candidate, heartbeat_runs_company_ctx_taskkey_created_idx, was
-- already dropped in 0477; heartbeat_runs_company_ctx_paperclip_issue_created_idx
-- is documented as a justified exception (1.6.8 audit section 3, plans analysis
-- pending live EXPLAIN in OPE-12979).

DROP INDEX IF EXISTS "secret_access_events_consumer_idx";
DROP INDEX IF EXISTS "secret_access_events_run_idx";
DROP INDEX IF EXISTS "secret_access_events_user_definition_created_idx";
