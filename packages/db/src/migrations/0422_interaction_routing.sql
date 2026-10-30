ALTER TABLE "issue_thread_interactions"
  ADD COLUMN IF NOT EXISTS "route_type" text,
  ADD COLUMN IF NOT EXISTS "addressee_queue" text,
  ADD COLUMN IF NOT EXISTS "timeout_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "escalation_chain" jsonb,
  ADD COLUMN IF NOT EXISTS "escalation_level" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_thread_interactions"
    ADD CONSTRAINT "issue_thread_interactions_route_address_check"
    CHECK ("route_type" IS NULL OR (
      (CASE WHEN "addressee_agent_id" IS NULL THEN 0 ELSE 1 END) +
      (CASE WHEN "addressee_user_id" IS NULL THEN 0 ELSE 1 END) +
      (CASE WHEN "addressee_queue" IS NULL THEN 0 ELSE 1 END) = 1
      AND "timeout_at" IS NOT NULL
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_thread_interactions"
    ADD CONSTRAINT "issue_thread_interactions_route_address_timeout_check"
    CHECK ("route_type" IS NULL OR "timeout_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_pending_timeout_idx"
  ON "issue_thread_interactions" USING btree ("status", "timeout_at")
  WHERE "status" = 'pending';
