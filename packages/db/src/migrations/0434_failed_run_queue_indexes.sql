-- PERF/OPE-10438: keep swarm failed-run aggregation on narrow indexes.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the production rollout prebuilds these indexes with CREATE INDEX CONCURRENTLY; this transactional migration is a no-op there and only serves fresh, small databases.
-- The queue probes recent terminal runs by company/status and then applies the
-- finished_at window. The issue and activity anti-joins previously had to scan
-- rows because their existing indexes began with unrelated company columns.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_failed_queue_idx"
  ON "heartbeat_runs" USING btree
    ("company_id", "status", "updated_at", "finished_at")
  WHERE "status" IN ('failed', 'timed_out') AND "finished_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_comments_issue_created_at_idx"
  ON "issue_comments" USING btree ("issue_id", "created_at")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_issue_created_at_idx"
  ON "activity_log" USING btree ("company_id", "entity_type", "entity_id", "created_at")
  WHERE "entity_type" = 'issue' AND "actor_type" <> 'system';
