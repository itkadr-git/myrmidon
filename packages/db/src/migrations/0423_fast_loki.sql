CREATE TABLE "knowledge_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"max_items" integer,
	"max_revision_bytes" integer,
	"auto_accept_enabled" boolean,
	"auto_accept_min_confidence" text,
	"schedule" text,
	"section_reviewers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_settings" ADD CONSTRAINT "knowledge_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_settings_company_uq" ON "knowledge_settings" USING btree ("company_id");