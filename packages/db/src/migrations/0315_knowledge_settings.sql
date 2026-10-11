-- myrmidon(1.7 KNOWLEDGE-2.0 L-11): one settings row per company for
-- "Settings → Knowledge". Every value column is nullable: null means the
-- screen never set it, and the resolver falls through to the environment
-- variable and then the default. `section_reviewers` is always a list.
CREATE TABLE IF NOT EXISTS "knowledge_settings" (
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
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_settings" ADD CONSTRAINT "knowledge_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_settings_company_uq" ON "knowledge_settings" USING btree ("company_id");
