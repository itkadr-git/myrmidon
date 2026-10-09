-- OPE-6671: release issues that were quarantined by the (since fixed) source-trust
-- rule which flagged any run-identity mismatch. Quarantine is meant for genuinely
-- untrusted *external* input (OPE-4418); lead-created subtasks from ordinary
-- internal automation runs were being tagged `disposition=quarantined` because
-- their creation run belongs to a different internal agent than the issue's
-- sourceAgentId key. Release exactly the rows whose provenance proves internal:
-- source_run_id resolves to a heartbeat run of the same company whose snapshot
-- carries no external-input marker, and the run's agent belongs to that company.
-- Real quarantines (external markers, unknown/foreign runs) stay in place.
-- The release is written in the promotion shape the app already understands
-- (`disposition=promoted`, system actor) so live readers (redaction, wake
-- envelopes, GitHub credential export) treat these issues as normal again.
WITH candidates AS MATERIALIZED (
  SELECT
    i.id,
    i.company_id,
    (i.source_trust ->> 'sourceRunId')::uuid AS source_run_id,
    i.source_trust ->> 'sourceAgentId' AS source_agent_id
  FROM "issues" i
  WHERE i.source_trust ->> 'preset' = 'low_trust_review'
    AND i.source_trust ->> 'disposition' = 'quarantined'
    AND i.source_trust ->> 'sourceRunId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
),
released AS (
  UPDATE "issues" i
  SET
    source_trust = jsonb_build_object(
      'preset', 'low_trust_review',
      'disposition', 'promoted',
      'sourceIssueId', i.source_trust -> 'sourceIssueId',
      'sourceRunId', i.source_trust -> 'sourceRunId',
      'sourceAgentId', i.source_trust -> 'sourceAgentId',
      'promotedFrom', jsonb_build_object(
        'artifactKind', 'issue',
        'artifactId', i.id::text,
        'issueId', COALESCE(i.source_trust ->> 'sourceIssueId', i.id::text)
      ),
      'promotedByActorType', 'system',
      'promotedByActorId', 'migration:0382_release_internal_low_trust_quarantine',
      'promotedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ),
    updated_at = now()
  FROM candidates c
  JOIN "heartbeat_runs" r
    ON r.id = c.source_run_id
   AND r.company_id = c.company_id
  JOIN "agents" a
    ON a.id = r.agent_id
   AND a.company_id = c.company_id
  WHERE i.id = c.id
    -- Mirror of server/src/services/source-trust.ts isExternalInputRunProvenance:
    -- a same-company run counts as internal unless it carries an external marker.
    -- COALESCE the jsonb equality tests: absent keys yield NULL, and `NOT (NULL)`
    -- would silently drop every clean internal row.
    AND NOT (
      COALESCE(r.context_snapshot -> 'paperclipExternalChatExecutionBound' = 'true'::jsonb, false)
      OR COALESCE(r.context_snapshot -> 'externalChatExecutionBound' = 'true'::jsonb, false)
      OR COALESCE(r.context_snapshot ->> 'source', '') LIKE 'chat:%'
      OR COALESCE(r.context_snapshot ->> 'wakeSource', '') LIKE 'chat:%'
      OR COALESCE(r.context_snapshot ->> 'source', '') IN ('webhook', 'external_api', 'api', 'discord', 'telegram', 'whatsapp')
      OR COALESCE(r.context_snapshot ->> 'wakeSource', '') IN ('webhook', 'external_api', 'api', 'discord', 'telegram', 'whatsapp')
      OR (r.context_snapshot ? 'webhookSource' AND COALESCE(r.context_snapshot ->> 'webhookSource', '') <> '')
    )
  RETURNING i.*
)
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
  r.company_id,
  'system',
  'migration:0382_release_internal_low_trust_quarantine',
  'issue.low_trust_released',
  'issue',
  r.id::text,
  jsonb_build_object(
    'reason', 'internal-run quarantine false positive (OPE-6671): creation run is a same-company internal run, not external input',
    'sourceRunId', r.source_trust ->> 'sourceRunId',
    'sourceAgentId', r.source_trust ->> 'sourceAgentId',
    'releasedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ),
  now()
FROM released r;
