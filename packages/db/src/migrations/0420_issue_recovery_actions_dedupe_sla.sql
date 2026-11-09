ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "owner_queue" text;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "sla_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "runbook_ref" text;--> statement-breakpoint
DROP INDEX IF EXISTS "issue_recovery_actions_active_source_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_recovery_actions_active_source_uq" ON "issue_recovery_actions" USING btree ("company_id", "source_issue_id") WHERE "status" in ('active', 'escalated') AND "dedupe_key" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_recovery_actions_active_dedupe_key_uq" ON "issue_recovery_actions" USING btree ("company_id", "dedupe_key") WHERE "status" in ('active', 'escalated') AND "dedupe_key" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_dedupe_owner_sla_check') THEN
    ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_dedupe_owner_sla_check"
      CHECK ("dedupe_key" IS NULL OR (
        (CASE WHEN "owner_agent_id" IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN "owner_user_id" IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN "owner_queue" IS NOT NULL THEN 1 ELSE 0 END) = 1
        AND "sla_due_at" IS NOT NULL
        AND "next_check_at" IS NOT NULL
      ));
  END IF;
END $$;
