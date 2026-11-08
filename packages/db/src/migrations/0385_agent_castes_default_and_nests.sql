-- myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the configurable default caste and
-- the agent nests.
--
-- 1. agent_castes.is_default — the company's default caste. The swarm matcher
--    resolves a task's caste as issues.caste_key ?? projects.default_caste_key
--    ?? this flag (server/src/myrmidon/castes/resolve.ts), so the old hard-coded
--    SWARM_DEFAULT_UNASSIGNED_ROLE ('engineer') stops being a constant of the
--    swarm logic and becomes a row the owner can move with the radio on the
--    castes screen.
--
--    Backfill keeps today's behaviour: engineer where the company has that
--    caste, else the company's lowest-key caste. The two statements are
--    idempotent (the NOT EXISTS guards) and add no row: the migration only
--    flags one existing caste per company.
--
--    The partial unique index is the invariant, not a convention: at most one
--    default per company, enforced by PostgreSQL. Flipping the radio therefore
--    cannot leave a company with two defaults even under concurrent writes.
--
-- 2. agent_nests — the projects an agent is willing to work in. No rows for an
--    agent means "the whole company" (eligible for every task); rows restrict
--    the agent to those projects plus the tasks that belong to no project.
--    Fresh read on every matcher pass: editing the nests changes the match
--    without a restart.
--
-- Additive only: one column + one partial index on agent_castes, one new table.
-- No vendor table is rewritten and no row is deleted. The table is expected to
-- hold a handful of rows per agent, so the index build is trivial and
-- check-migration-safety.ts has nothing to report.
ALTER TABLE "agent_castes" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "agent_castes" AS c SET "is_default" = true
WHERE c."key" = 'engineer'
  AND NOT EXISTS (
    SELECT 1 FROM "agent_castes" AS d
    WHERE d."company_id" = c."company_id" AND d."is_default"
  );--> statement-breakpoint
UPDATE "agent_castes" AS c SET "is_default" = true
WHERE c."key" = (
    SELECT min(k."key") FROM "agent_castes" AS k WHERE k."company_id" = c."company_id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "agent_castes" AS d
    WHERE d."company_id" = c."company_id" AND d."is_default"
  );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_castes_company_default_uq" ON "agent_castes" USING btree ("company_id") WHERE "is_default";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_nests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_nests" ADD CONSTRAINT "agent_nests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_nests" ADD CONSTRAINT "agent_nests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_nests" ADD CONSTRAINT "agent_nests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_nests_agent_project_uq" ON "agent_nests" USING btree ("agent_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_nests_company_agent_idx" ON "agent_nests" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_nests_project_idx" ON "agent_nests" USING btree ("project_id");