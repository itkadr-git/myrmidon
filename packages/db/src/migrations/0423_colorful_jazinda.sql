ALTER TABLE "issues" ADD COLUMN "responsible_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_responsible_agent_id_agents_id_fk" FOREIGN KEY ("responsible_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_company_responsible_agent_idx" ON "issues" USING btree ("company_id","responsible_agent_id");--> statement-breakpoint
WITH RECURSIVE agent_roots AS (
  SELECT id AS root_id, id AS agent_id, company_id, 0 AS depth
  FROM agents
  WHERE reports_to IS NULL AND status != 'terminated' AND status != 'paused'

  UNION ALL

  SELECT r.root_id, a.id AS agent_id, a.company_id, r.depth + 1
  FROM agents a
  JOIN agent_roots r ON a.reports_to = r.agent_id
  WHERE r.depth < 20
),
company_default_roots AS (
  SELECT DISTINCT ON (company_id) id AS root_id, company_id
  FROM agents
  WHERE reports_to IS NULL AND status != 'terminated' AND status != 'paused'
  ORDER BY company_id,
    CASE
      WHEN lower(trim(name)) IN ('adm', 'bbq', 'work', 'life', 'dispatch') THEN 0
      WHEN lower(trim(name)) LIKE 'adm%' THEN 1
      WHEN lower(trim(name)) LIKE 'bbq%' THEN 2
      WHEN lower(trim(name)) LIKE 'work%' THEN 3
      WHEN lower(trim(name)) LIKE 'life%' THEN 4
      WHEN lower(trim(name)) LIKE 'dispatch%' THEN 5
      ELSE 6
    END,
    created_at ASC
),
project_roots AS (
  SELECT p.id AS project_id, ar.root_id
  FROM projects p
  JOIN agent_roots ar ON p.lead_agent_id = ar.agent_id
),
resolved_heads AS (
  SELECT
    i.id AS issue_id,
    COALESCE(
      ar_assignee.root_id,
      pr.root_id,
      ar_creator.root_id,
      cdr.root_id
    ) AS head_agent_id
  FROM issues i
  LEFT JOIN agent_roots ar_assignee ON i.assignee_agent_id = ar_assignee.agent_id
  LEFT JOIN project_roots pr ON i.project_id = pr.project_id
  LEFT JOIN agent_roots ar_creator ON i.created_by_agent_id = ar_creator.agent_id
  LEFT JOIN company_default_roots cdr ON i.company_id = cdr.company_id
  WHERE (i.created_by_user_id IS NULL OR i.created_by_agent_id IS NOT NULL)
)
UPDATE issues
SET
  responsible_agent_id = resolved_heads.head_agent_id,
  responsible_user_id = NULL
FROM resolved_heads
WHERE issues.id = resolved_heads.issue_id
  AND resolved_heads.head_agent_id IS NOT NULL;
