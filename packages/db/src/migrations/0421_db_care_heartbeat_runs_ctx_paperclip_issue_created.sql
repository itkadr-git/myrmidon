-- myrmidon(DB-CARE / DBC-2): persist the production index used by
-- run-secret-redaction.ts to resolve runs by company and the nested Paperclip
-- issue id, ordered newest first. IF NOT EXISTS preserves the hand-created
-- production index and makes this migration safe when it already exists.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id",(("context_snapshot" -> 'paperclipIssue') ->> 'id'),"created_at" DESC);