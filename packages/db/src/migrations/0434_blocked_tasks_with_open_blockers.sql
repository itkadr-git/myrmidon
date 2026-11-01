UPDATE "issues"
SET "status" = 'blocked',
    "blocker_metadata" = jsonb_set(COALESCE("blocker_metadata", '{}'::jsonb), '{previousStatus}', to_jsonb("status")),
    "blocked_transition_at" = COALESCE("blocked_transition_at", now()),
    "status_version" = "status_version" + 1
WHERE "status" IN ('todo', 'in_progress')
  AND EXISTS (
    SELECT 1
    FROM "issue_relations" ir
    JOIN "issues" blocker ON blocker."id" = ir."issue_id" AND blocker."company_id" = "issues"."company_id"
    WHERE ir."company_id" = "issues"."company_id"
      AND ir."related_issue_id" = "issues"."id"
      AND ir."type" = 'blocks'
      AND blocker."status" NOT IN ('done', 'cancelled')
  );
