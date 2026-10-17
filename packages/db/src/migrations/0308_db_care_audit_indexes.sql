-- myrmidon(DB-CARE / DBC-2): the datastore audit of 07-08.10.2026 measured five
-- hot predicates that no existing index served on the production board
-- database and created the matching indexes there by hand. This forward
-- migration persists them as managed objects: on production every statement is
-- a no-op (CREATE INDEX IF NOT EXISTS keeps the hand-made index), and a fresh
-- installation builds the same five indexes, so `pg_indexes` matches the
-- Drizzle schema everywhere.
--
-- 1) heartbeat_runs (company_id, agent_id, created_at, ctx issueId, ctx taskId)
--    - the attention feed (server/src/services/attention.ts) lists the runs of
--    one agent inside a created_at window and projects the issue and task ids
--    out of the snapshot; the earlier agent-keyed index orders by started_at.
-- 2) heartbeat_runs (company_id, ctx->'paperclipIssue'->>'id') WHERE the
--    snapshot carries that key - the wake admission path resolves the runs
--    bound to one paperclip issue straight from the snapshot.
-- 3) heartbeat_runs (updated_at) - the stuck-run sweeper scans by updated_at.
-- 4) activity_log (company_id, entity_id, created_at DESC) WHERE the row is an
--    issue event that is not a read/inbox marker - the issue activity view.
-- 5) issue_comments lower(body) gin_trgm_ops WHERE the row is not deleted -
--    the comment search path (trigram) had no index on the lowered body.
--
-- activity_log and issue_comments are bucketed "large" by
-- check-migration-safety.ts, so a plain CREATE INDEX is reported for them; a
-- migration cannot use CONCURRENTLY because it runs inside a transaction, and
-- both indexes exist on the one large production instance already, so the lock
-- window there is zero and fresh instances build empty tables.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_attention_feed_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at",("context_snapshot" ->> 'issueId'),("context_snapshot" ->> 'taskId'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_ctx_paperclip_issue_id_idx" ON "heartbeat_runs" USING btree ("company_id",(("context_snapshot" -> 'paperclipIssue') ->> 'id')) WHERE "context_snapshot" ? 'paperclipIssue';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_updated_at_idx" ON "heartbeat_runs" USING btree ("updated_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally so CONCURRENTLY is unavailable; the index exists on the one large production instance already, and this statement is a no-op there.
CREATE INDEX IF NOT EXISTS "activity_log_issue_last_activity_idx" ON "activity_log" USING btree ("company_id","entity_id","created_at" DESC) WHERE "entity_type" = 'issue' and "action" <> ALL (ARRAY['issue.read_marked', 'issue.read_unmarked', 'issue.inbox_archived', 'issue.inbox_unarchived']);--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally so CONCURRENTLY is unavailable; the index exists on the one large production instance already, and this statement is a no-op there.
CREATE INDEX IF NOT EXISTS "issue_comments_body_lower_trgm_idx" ON "issue_comments" USING gin (lower("body") gin_trgm_ops) WHERE "deleted_at" is null;