CREATE TABLE "legacy_blocked_import" (
	"company_id" uuid NOT NULL,
	"import_key" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"class" text NOT NULL,
	"result_issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_blocked_import_company_import_key_uq" UNIQUE("company_id","import_key")
);

--> statement-breakpoint
ALTER TABLE "legacy_blocked_import" ADD CONSTRAINT "legacy_blocked_import_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "legacy_blocked_import" ADD CONSTRAINT "legacy_blocked_import_result_issue_id_issues_id_fk" FOREIGN KEY ("result_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "legacy_blocked_import" ADD CONSTRAINT "legacy_blocked_import_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "legacy_blocked_import_issue_id_idx" ON "legacy_blocked_import" USING btree ("issue_id");
