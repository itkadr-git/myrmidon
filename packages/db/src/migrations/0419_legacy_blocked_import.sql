CREATE TABLE "legacy_blocked_import" (
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"import_key" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"class" text NOT NULL,
	"result_issue_id" uuid,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "legacy_blocked_import_company_import_key_uq" UNIQUE ("company_id", "import_key"),
	CONSTRAINT "legacy_blocked_import_issue_company_fk" FOREIGN KEY ("company_id", "issue_id") REFERENCES "issues"("company_id", "id") ON DELETE CASCADE,
	CONSTRAINT "legacy_blocked_import_result_issue_id_issues_id_fk" FOREIGN KEY ("result_issue_id") REFERENCES "issues"("id") ON DELETE SET NULL
);

CREATE INDEX "legacy_blocked_import_issue_id_idx" ON "legacy_blocked_import" USING btree ("issue_id");