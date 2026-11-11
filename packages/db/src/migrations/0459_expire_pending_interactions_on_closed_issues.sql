UPDATE issue_thread_interactions AS interaction
SET
  status = 'expired',
  result = jsonb_set(
    jsonb_set(
      COALESCE(interaction.result, '{"version":1}'::jsonb),
      '{outcome}',
      CASE
        WHEN interaction.kind = 'connection_intent' THEN '"expired"'::jsonb
        ELSE '"issue_closed"'::jsonb
      END,
      true
    ),
    '{expirationReason}',
    '"issue_closed"'::jsonb,
    true
  ),
  resolved_at = COALESCE(interaction.resolved_at, interaction.updated_at, now()),
  updated_at = now()
FROM issues AS issue
WHERE interaction.issue_id = issue.id
  AND interaction.company_id = issue.company_id
  AND interaction.status = 'pending'
  AND issue.status IN ('done', 'cancelled');
