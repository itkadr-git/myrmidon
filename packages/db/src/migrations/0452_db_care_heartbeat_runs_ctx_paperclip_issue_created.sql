-- myrmidon(DB-CARE / DBC-2): source index present on production and used by
-- valuesForIssue. IF NOT EXISTS preserves the hand-created production index.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id", (("context_snapshot" -> 'paperclipIssue') ->> 'id'), "created_at" DESC);
--> statement-breakpoint
