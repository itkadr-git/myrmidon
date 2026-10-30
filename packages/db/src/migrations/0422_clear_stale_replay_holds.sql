-- migration 0422_clear_stale_replay_holds.sql
-- 1. Deduplicate historical issue_recovery_actions with replay = 'blocked'
--    scoped strictly to resolved/cancelled recovery actions.
-- 2. Clear stale replay holds (>24h old) on open workable issues (todo/in_progress)
--    without external wait / blockers (pending interactions, pending approvals,
--    unblockDescriptor, or active blocks relations), scoped strictly to resolved/cancelled.
-- 3. Record audit trail in activity_log for all modified actions.

DO $$
DECLARE
  dedupe_count INTEGER := 0;
  stale_count INTEGER := 0;
BEGIN
  -- Step 1: Deduplicate historical holds where multiple actions hold the same issue.
  -- Scoped strictly to status IN ('resolved', 'cancelled').
  -- Keeps the most recent action (rank 1) as-is, and clears older duplicates (rank > 1).
  WITH ranked_holds AS (
    SELECT
      ira.id,
      ira.source_issue_id,
      ira.evidence AS original_evidence,
      i.company_id,
      ROW_NUMBER() OVER (
        PARTITION BY ira.source_issue_id
        ORDER BY ira.created_at DESC, ira.id DESC
      ) AS rank
    FROM "issue_recovery_actions" ira
    JOIN "issues" i ON i.id = ira.source_issue_id
    WHERE ira."evidence"->'automaticRecovery'->>'replay' = 'blocked'
      AND ira."status" IN ('resolved', 'cancelled')
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
          'previousEvidence', r.original_evidence
        )
      ),
      "updated_at" = NOW()
    FROM ranked_holds r
    WHERE ira.id = r.id AND r.rank > 1
    RETURNING ira.id, r.source_issue_id, r.original_evidence, r.company_id
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
      d.company_id,
      'system',
      'migration_0422',
      'issue.execution_recovery_settled',
      'issue',
      d.source_issue_id,
      jsonb_build_object(
        'actionId', d.id,
        'sourceIssueId', d.source_issue_id,
        'reason', 'migration_0422_dedupe: historical duplicate hold superseded',
        'clearedAt', NOW()::text,
        'previousEvidence', d.original_evidence
      ),
      NOW()
    FROM deduped_rows d
    RETURNING 1
  )
  SELECT count(*) INTO dedupe_count FROM deduped_rows;

  -- Step 2: Clear stale replay holds (>24h old) on open workable issues
  -- scoped to status IN ('resolved', 'cancelled') and issues in ('todo', 'in_progress')
  -- without external wait or open blockers (pending interactions, pending approvals,
  -- unblockDescriptor, or active blocks relations).
  WITH stale_candidates AS (
    SELECT
      ira.id,
      ira.source_issue_id,
      ira.evidence AS original_evidence,
      i.company_id
    FROM "issue_recovery_actions" ira
    JOIN "issues" i ON ira.source_issue_id = i.id
    WHERE ira.evidence->'automaticRecovery'->>'replay' = 'blocked'
      AND ira.status IN ('resolved', 'cancelled')
      AND i.status IN ('todo', 'in_progress')
      AND ira.created_at < NOW() - INTERVAL '24 hours'
      AND i.unblock_descriptor IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "issue_thread_interactions" iti
        WHERE iti.issue_id = i.id
          AND iti.status = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "issue_approvals" ia
        JOIN "approvals" a ON ia.approval_id = a.id
        WHERE ia.issue_id = i.id
          AND a.status IN ('pending', 'revision_requested')
      )
      AND NOT EXISTS (
        SELECT 1 FROM "issue_relations" ir
        JOIN "issues" b ON ir.issue_id = b.id
        WHERE ir.related_issue_id = i.id
          AND ir.type = 'blocks'
          AND b.status NOT IN ('done', 'cancelled')
      )
  ),
  stale_rows AS (
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
          'replayClearedNote', 'Stale hold cleared (>24h old on safe workable issue)',
          'previousEvidence', sc.original_evidence
        )
      ),
      "updated_at" = NOW()
    FROM stale_candidates sc
    WHERE ira.id = sc.id
    RETURNING ira.id, sc.source_issue_id, sc.original_evidence, sc.company_id
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
      s.company_id,
      'system',
      'migration_0422',
      'issue.execution_recovery_settled',
      'issue',
      s.source_issue_id,
      jsonb_build_object(
        'actionId', s.id,
        'sourceIssueId', s.source_issue_id,
        'reason', 'migration_0422_stale: stale hold cleared (>24h on safe workable issue)',
        'clearedAt', NOW()::text,
        'previousEvidence', s.original_evidence
      ),
      NOW()
    FROM stale_rows s
    RETURNING 1
  )
  SELECT count(*) INTO stale_count FROM stale_rows;

  RAISE NOTICE '0422_clear_stale_replay_holds: deduped % duplicate holds, cleared % stale holds older than 24h on safe workable issues',
    dedupe_count, stale_count;
END $$;
