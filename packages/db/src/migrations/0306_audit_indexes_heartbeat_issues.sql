-- myrmidon(DB-AUDIT-INDEXES): the four missing indexes from the database audit
-- section 2. Each one serves a measured hot query (audit section 1):
--   heartbeat_runs_company_agent_created_idx   - the attention feed: agent_id IN
--     (...) plus created_at > oldest unresolved failure (P3, 1 926 s per window;
--     the planner was filtering created_at on an index keyed by started_at).
--   heartbeat_runs_ctx_issue_status_idx        - the chat-reconcile milestone
--     projection, which joins context_snapshot->>'issueId' to
--     chat_conversations and filters status (P5, 2 197 s per window).
--   issues_company_execution_run_idx /
--   issues_company_checkout_run_idx            - the FOR UPDATE claim lockup of
--     issues: company + (id or execution_run_id or checkout_run_id) ran as a
--     Seq Scan because only partial unique indexes covered those columns (P6,
--     2.6k s plus lock waits on neighbouring rows).
-- The P1 blocker expression index (company, coalesced issue reference, created_at)
-- is deliberately NOT here: PR #619 migration
-- 0302 persists it, and duplicating it would fight that merge order.
-- IF NOT EXISTS keeps re-runs a no-op. Drizzle migrations run transactionally,
-- so CONCURRENTLY is unavailable; heartbeat_runs and issues are bucketed
-- "medium" by check-migration-safety.ts, so a plain CREATE INDEX is the
-- expected form here (same shape as 0301 in PR #593). On the large production
-- instance the builds are seconds; deploys run through the operator's
-- maintenance mode.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_created_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_ctx_issue_status_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" ->> 'issueId'),"status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_execution_run_idx" ON "issues" USING btree ("company_id","execution_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_checkout_run_idx" ON "issues" USING btree ("company_id","checkout_run_id");
