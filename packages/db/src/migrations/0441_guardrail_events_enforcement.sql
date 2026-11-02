ALTER TABLE "guardrail_events" ADD COLUMN IF NOT EXISTS "rule" text;--> statement-breakpoint
ALTER TABLE "guardrail_events" ADD COLUMN IF NOT EXISTS "mode" text;--> statement-breakpoint
ALTER TABLE "guardrail_events" ADD COLUMN IF NOT EXISTS "level" text;--> statement-breakpoint
ALTER TABLE "guardrail_events" ADD COLUMN IF NOT EXISTS "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "guardrail_events" ADD COLUMN IF NOT EXISTS "decision" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_events_agent_id_idx" ON "guardrail_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guardrail_events_rule_idx" ON "guardrail_events" USING btree ("rule");
