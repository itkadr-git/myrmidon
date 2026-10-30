-- migration 0422_clear_stale_replay_holds.sql
-- 1. Deduplicate historical issue_recovery_actions with replay = 'blocked'
--    scoped strictly to resolved/cancelled recovery actions.
-- 2. Clear stale replay holds (>24 hours old) on open workable issues
--    without external wait / blockers, scoped to resolved/cancelled recovery actions.
-- 3. Emit notice with verifiable before/after counts and preserve durable audit records.

DO $$
DECLARE
  dedupe_count integer := 0;
  stale_count integer := 0;
BEGIN
  -- Step 1: Deduplicate historical replay holds (status in 'resolved', 'cancelled')
  -- Keeping only the newest action per source_issue_id; older duplicates are marked cleared.
  WITH ranked_holds AS (
    SELECT
      id,
      source_issue_id,
      ROW_NUMBER() OVER (
        PARTITION BY source_issue_id
        ORDER BY created_at DESC, id DESC
      ) AS rank
    FROM "issue_recovery_actions"
    WHERE "evidence"->'automaticRecovery'->>'replay' = 'blocked'
      AND "status" IN ('resolved', 'cancelled')
  ),
  deduped_rows AS (
    UPDATE "issue_recovery_actions" ira
    SET
      "evidence" = jsonb_set(
        ira.evidence,
        '{automaticRecovery,replay}',
        '"cleared"'
      ) || jsonb_build_object(
        'automaticRecovery',
        (ira.evidence->'automaticRecovery') || jsonb_build_object(
          'replay', 'cleared',
          'replayClearedAt', NOW()::text,
          'replayClearedBy', 'migration_0422_dedupe',
          'replayClearedNote', 'Deduplicated historical hold superseded by later action',
          'previousEvidence', ira.evidence
        )
      ),
      "updated_at" = NOW()
    FROM ranked_holds r
    WHERE ira.id = r.id AND r.rank > 1
    RETURNING ira.id, ira.source_issue_id, ira.evidence
  ),
  audit_dedupe AS (
    INSERT INTO "activity_log" (
      "id",
      "company_id",
      "actor_type",
      "actor_id",
      "action",
      "entity_type",
      "entity_id",
      "details",
      "created_at"
    )
    SELECT
      gen_random_uuid(),
      i.company_id,
      'system',
      'migration_0422',
      'issue.execution_recovery_settled',
      'issue',
      i.id,
      jsonb_build_object(
        'actionId', d.id,
        'sourceIssueId', d.source_issue_id,
        'reason', 'migration_0422_dedupe: historical duplicate hold superseded',
        'clearedAt', NOW()::text,
        'previousEvidence', d.evidence
      ),
      NOW()
    FROM deduped_rows d
    JOIN "issues" i ON i.id = d.source_issue_id
    RETURNING 1
  )
  SELECT count(*) INTO dedupe_count FROM deduped_rows;

  -- Step 2: Clear stale replay holds (>24h old) on open workable issues
  -- scoped to status IN ('resolved', 'cancelled') and issues in ('todo', 'in_progress').
  WITH stale_rows AS (
    UPDATE "issue_recovery_actions" ira
    SET
      "evidence" = jsonb_set(
        ira.evidence,
        '{automaticRecovery,replay}',
        '"cleared"'
      ) || jsonb_build_object(
        'automaticRecovery',
        (ira.evidence->'automaticRecovery') || jsonb_build_object(
          'replay', 'cleared',
          'replayClearedAt', NOW()::text,
          'replayClearedBy', 'migration_0422_stale',
          'replayClearedNote', 'Stale hold cleared (>24h old on open issue)',
          'previousEvidence', ira.evidence
        )
      ),
      "updated_at" = NOW()
    FROM "issues" i
    WHERE ira.source_issue_id = i.id
      AND ira.evidence->'automaticRecovery'->>'replay' = 'blocked'
      AND ira.status IN ('resolved', 'cancelled')
      AND i.status IN ('todo', 'in_progress')
      AND ira.created_at < NOW() - INTERVAL '24 hours'
    RETURNING ira.id, ira.source_issue_id, ira.evidence
  ),
  audit_stale AS (
    INSERT INTO "activity_log" (
      "id",
      "company_id",
      "actor_type",
      "actor_id",
      "action",
      "entity_type",
      "entity_id",
      "details",
      "created_at"
    )
    SELECT
      gen_random_uuid(),
      i.company_id,
      'system',
      'migration_0422',
      'issue.execution_recovery_settled',
      'issue',
      i.id,
      jsonb_build_object(
        'actionId', s.id,
        'sourceIssueId', s.source_issue_id,
        'reason', 'migration_0422_stale: stale hold cleared (>24h on open issue)',
        'clearedAt', NOW()::text,
        'previousEvidence', s.evidence
      ),
      NOW()
    FROM stale_rows s
    JOIN "issues" i ON i.id = s.source_issue_id
    RETURNING 1
  )
  SELECT count(*) INTO stale_count FROM stale_rows;

  IF dedupe_count > 0 OR stale_count > 0 THEN
    RAISE NOTICE 'migration 0422: deduplicated % historical replay hold(s), cleared % stale (>24h) replay hold(s)', dedupe_count, stale_count;
  END IF;
END $$;
