-- OPE-6671: DRY RUN ONLY. This migration does NOT change any issue.
-- An earlier, withdrawn draft released every quarantined issue whose creation
-- run lacked a known external marker. Review (443fbb009) showed that signal is
-- fail-open (answers to external-chat questions carry no marker, markers are
-- erased from snapshots), so a bulk UPDATE is not safe. Instead, record the
-- issues whose creation run is *provably internal* by the same allowlist the
-- app uses (server/src/services/source-trust.ts isProvenInternalRunProvenance:
-- invocation_source in assignment/automation/timer; snapshot source/wakeSource
-- absent or on the internal list; no external-chat/webhook marker; same-company
-- run owned by a same-company agent) as audit rows. An operator reviews the
-- listed ids and releases the confirmed ones through the existing
-- POST /api/issues/:id/low-trust/promotions path. Idempotent: one row per issue.
INSERT INTO "activity_log" (
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
  i.company_id,
  'system',
  'migration:0385_low_trust_internal_release_candidates',
  'issue.low_trust_release_candidate',
  'issue',
  i.id::text,
  jsonb_build_object(
    'reason', 'quarantined issue whose creation run is provably internal (OPE-6671); needs manual review, nothing was released',
    'sourceRunId', i.source_trust ->> 'sourceRunId',
    'sourceAgentId', i.source_trust ->> 'sourceAgentId',
    'runInvocationSource', r.invocation_source,
    'dryRun', true
  ),
  now()
FROM "issues" i
JOIN "heartbeat_runs" r
  ON r.company_id = i.company_id
 AND i.source_trust ->> 'sourceRunId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
 AND r.id = (i.source_trust ->> 'sourceRunId')::uuid
JOIN "agents" a
  ON a.id = r.agent_id
 AND a.company_id = i.company_id
WHERE i.source_trust ->> 'preset' = 'low_trust_review'
  AND i.source_trust ->> 'disposition' = 'quarantined'
  -- Allowlist (mirror of INTERNAL_INVOCATION_SOURCES / INTERNAL_SNAPSHOT_SOURCES).
  AND r.invocation_source IN ('assignment', 'automation', 'timer')
  AND COALESCE(r.context_snapshot ->> 'source', 'automation') IN (
    'automation', 'timer', 'scheduler', 'assignment', 'routine.dispatch',
    'issue.assignment_recovery', 'issue.assigned_todo_liveness_dispatch',
    'issue.children_completed', 'issue.blockers_resolved'
  )
  AND COALESCE(r.context_snapshot ->> 'wakeSource', 'automation') IN (
    'automation', 'timer', 'scheduler', 'assignment', 'routine.dispatch',
    'issue.assignment_recovery', 'issue.assigned_todo_liveness_dispatch',
    'issue.children_completed', 'issue.blockers_resolved'
  )
  AND NOT COALESCE(r.context_snapshot -> 'paperclipExternalChatExecutionBound' = 'true'::jsonb, false)
  AND NOT COALESCE(r.context_snapshot -> 'externalChatExecutionBound' = 'true'::jsonb, false)
  AND COALESCE(r.context_snapshot ->> 'webhookSource', '') = ''
  AND NOT EXISTS (
    SELECT 1 FROM "activity_log" al
    WHERE al.action = 'issue.low_trust_release_candidate'
      AND al.entity_type = 'issue'
      AND al.entity_id = i.id::text
  );
