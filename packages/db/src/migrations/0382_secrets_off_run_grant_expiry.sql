-- myrmidon(1.6.5-F-23): off-run self-secret reads for administrative agents.
-- principal_permission_grants.expires_at carries the validity deadline of a
-- grant (used by the secrets:read_off_run grant, default +30 days at issue).
-- decidePrincipalGrant denies expired grants; the attention feed surfaces a
-- signal three days before the deadline.
-- secret_access_events.details carries structured audit attributes for reads
-- that do not fit the fixed columns — first consumer: the off-run read path
-- records { offRun: true, keyId, remoteAddress }.
ALTER TABLE "principal_permission_grants" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "secret_access_events" ADD COLUMN "details" jsonb;
