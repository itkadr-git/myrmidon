-- myrmidon(1.6.1-FORAGING-LIMITS-UI): the spend ledger of the learning sweep.
-- Additive only: one new table plus its indexes and two foreign keys; no vendor
-- table is touched, no data is rewritten (generated with drizzle-kit).
CREATE TABLE "foraging_spend_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"role" text NOT NULL,
	"agent_id" uuid,
	"url" text NOT NULL,
	"cost_cents" integer NOT NULL,
	"outcome" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "foraging_spend_events" ADD CONSTRAINT "foraging_spend_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foraging_spend_events" ADD CONSTRAINT "foraging_spend_events_source_id_foraging_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."foraging_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "foraging_spend_company_occurred_idx" ON "foraging_spend_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "foraging_spend_company_role_idx" ON "foraging_spend_events" USING btree ("company_id","role");--> statement-breakpoint
CREATE INDEX "foraging_spend_company_agent_idx" ON "foraging_spend_events" USING btree ("company_id","agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "foraging_spend_source_idx" ON "foraging_spend_events" USING btree ("source_id");
