CREATE TABLE IF NOT EXISTS "issue_continuation_keys" (
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_continuation_keys" ADD CONSTRAINT "issue_continuation_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_continuation_keys" ADD CONSTRAINT "issue_continuation_keys_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_continuation_keys_company_key_uq" ON "issue_continuation_keys" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_continuation_keys_expires_at_idx" ON "issue_continuation_keys" USING btree ("expires_at");