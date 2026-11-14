-- 1.8 AGENT-LIVENESS C2 (OPE-13023): append-only agent recovery journal.
CREATE TABLE "agent_recovery_journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"step" text NOT NULL,
	"cause" text NOT NULL,
	"dedup_key" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suppressed_reason" text
);
--> statement-breakpoint
ALTER TABLE "agent_recovery_journal" ADD CONSTRAINT "agent_recovery_journal_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_recovery_journal" ADD CONSTRAINT "agent_recovery_journal_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_recovery_journal_company_agent_created_idx" ON "agent_recovery_journal" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_recovery_journal_agent_created_idx" ON "agent_recovery_journal" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_recovery_journal_company_created_idx" ON "agent_recovery_journal" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_recovery_journal_dedup_key_created_idx" ON "agent_recovery_journal" USING btree ("dedup_key","created_at");--> statement-breakpoint
CREATE INDEX "agent_recovery_journal_created_idx" ON "agent_recovery_journal" USING btree ("created_at");
