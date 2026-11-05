-- One-time backfill after deploying the terminal-issue expiry hook.
-- Run with: psql -v ON_ERROR_STOP=1 --single-transaction -f scripts/myrmidon/migrations/close-pending-interactions-on-terminal-issues.sql
-- Safe to re-run: only pending rows are changed; activity is written for changed rows.
WITH closed AS (
  UPDATE "issue_thread_interactions" AS interaction
  SET
    "status" = 'expired',
    "result" = jsonb_build_object(
      'version', 1,
      'outcome', 'issue_closed'
    ),
    "resolved_at" = COALESCE("resolved_at", now()),
    "updated_at" = now()
  FROM "issues" AS issue
  WHERE interaction."issue_id" = issue."id"
    AND interaction."company_id" = issue."company_id"
    AND interaction."status" = 'pending'
    AND issue."status" IN ('done', 'cancelled')
  RETURNING
    interaction."id",
    interaction."kind",
    interaction."company_id",
    interaction."issue_id",
    interaction."status"
)
INSERT INTO "activity_log" (
  "company_id",
  "actor_type",
  "actor_id",
  "action",
  "entity_type",
  "entity_id",
  "details"
)
SELECT
  "company_id",
  'system',
  'issue_interaction_backfill',
  'issue.thread_interaction_expired',
  'issue',
  "issue_id"::text,
  jsonb_build_object(
    'interactionId', "id",
    'interactionKind', "kind",
    'interactionStatus', "status",
    'source', 'migration.issue_closed_interactions'
  )
FROM closed;
