CREATE TABLE "interaction_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"from_recipient" jsonb NOT NULL,
	"to_recipient" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interaction_escalations" ADD CONSTRAINT "interaction_escalations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_escalations" ADD CONSTRAINT "interaction_escalations_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_escalations_interaction_level_uq" ON "interaction_escalations" USING btree ("interaction_id","level");--> statement-breakpoint
CREATE INDEX "interaction_escalations_company_created_at_idx" ON "interaction_escalations" USING btree ("company_id","created_at");