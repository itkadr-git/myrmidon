-- myrmidon(1.6.6 QUOTA-V2, OPE-6877): the per-project token quota — one row per
-- project (company scoped) with daily/weekly token limits (null = unlimited),
-- the running usage counters and the window-start stamps used by the quota
-- service to roll the windows. Additive only: one new table plus two indexes,
-- no vendor table touched, no data rewritten.
CREATE TABLE "project_token_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"daily_token_limit" bigint,
	"weekly_token_limit" bigint,
	"daily_tokens_used" bigint DEFAULT 0 NOT NULL,
	"weekly_tokens_used" bigint DEFAULT 0 NOT NULL,
	"daily_window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"weekly_window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"set_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_token_quotas" ADD CONSTRAINT "project_token_quotas_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_token_quotas" ADD CONSTRAINT "project_token_quotas_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "project_token_quotas_project_unique_idx" ON "project_token_quotas" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "project_token_quotas_company_idx" ON "project_token_quotas" USING btree ("company_id");
