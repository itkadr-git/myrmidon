-- SWARM-B: the matcher reads provider-quota failures per candidate agent on every match.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_provider_quota_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at") WHERE "heartbeat_runs"."error_code" = 'provider_quota';
