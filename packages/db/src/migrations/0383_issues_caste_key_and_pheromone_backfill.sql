-- 1.6.5 (F-27 PHEROMONE, architect rework 09.10): the task's caste as a real
-- column (design §2.1) plus the project's default caste (the nest's caste),
-- and the one-time backfill of pheromone strength from `priority`.
--
-- 1) `issues.caste_key` — a key of the company's caste directory
--    (`agent_castes.key`); NULL falls back to the project's default caste,
--    then the company default. Replaces the `role:<key>` label as the swarm
--    routing source (the label picker and reader stay as a fallback for
--    installs that still carry such labels — the migration below lifts them).
-- 2) `projects.default_caste_key` — the caste a task of this project falls
--    back to (the nest, design §2.2).
-- 3) Backfill `pheromone_strength` for rows still at the column default 0
--    from `priority` by the documented `swarm.pheromoneDefaults` mapping
--    (critical 100 / high 30 / medium 10 / low 1). Rows whose strength an
--    operator already set (non-zero) keep it — the backfill must not trample
--    a deliberate 0, and between the column landing and this migration only
--    creates with the mapping applied (never 0 for a known priority) or
--    explicit values exist.
-- 4) Lift existing `role:<key>` labels into `caste_key` when the key exists
--    in the company's caste directory (on the production board there are no
--    such labels; this is for other installs). The first matching label wins,
--    mirroring `swarmRoleFromLabels`.
-- 5) `issues_company_caste_idx` — swarm-claim routing filters ready tasks by
--    caste per company; declared in the drizzle schema so the snapshot test
--    stays in sync.

ALTER TABLE "issues" ADD COLUMN "caste_key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_caste_key" text;--> statement-breakpoint
UPDATE "issues"
SET "pheromone_strength" = CASE lower("priority")
  WHEN 'critical' THEN 100
  WHEN 'high' THEN 30
  WHEN 'medium' THEN 10
  WHEN 'low' THEN 1
  ELSE 10
END
WHERE "pheromone_strength" = 0;--> statement-breakpoint
UPDATE "issues" i
SET "caste_key" = sub.caste_key
FROM (
  SELECT DISTINCT ON (il.issue_id)
    il.issue_id,
    lower(btrim(substring(l.name from 6))) AS caste_key
  FROM issue_labels il
    JOIN labels l ON l.id = il.label_id
    JOIN issues i2 ON i2.id = il.issue_id
  WHERE lower(btrim(l.name)) LIKE 'role:%'
    AND EXISTS (
      SELECT 1 FROM agent_castes ac
      WHERE ac.company_id = i2.company_id
        AND ac.key = lower(btrim(substring(l.name from 6)))
    )
  ORDER BY il.issue_id, il.label_id
) sub
WHERE i.id = sub.issue_id
  AND i.caste_key IS NULL;--> statement-breakpoint
CREATE INDEX "issues_company_caste_idx" ON "issues" USING btree ("company_id","caste_key");
