CREATE TABLE IF NOT EXISTS "company_secret_github_app_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "installation_id" text NOT NULL,
  "display_name" text NOT NULL,
  "app_id" text NOT NULL,
  "private_key_ciphertext" text NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'ready' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_secret_github_app_installations_company_id_companies_id_fk') THEN
    ALTER TABLE "company_secret_github_app_installations"
      ADD CONSTRAINT "company_secret_github_app_installations_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secret_github_app_installations_company_idx"
  ON "company_secret_github_app_installations" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secret_github_app_installations_company_installation_uq"
  ON "company_secret_github_app_installations" USING btree ("company_id", "installation_id");
