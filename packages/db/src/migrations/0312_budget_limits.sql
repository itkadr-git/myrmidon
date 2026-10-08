-- myrmidon(1.7-BUDGET-CONFIG A): per-level spend limits and change journal (OPE-4549/OPE-5339).
CREATE TABLE "budget_limit_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"limit_id" uuid,
	"action" text NOT NULL,
	"level" text NOT NULL,
	"ref" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"level" text NOT NULL,
	"ref" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"period" text DEFAULT 'calendar_month_utc' NOT NULL,
	"mode" text DEFAULT 'hard' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_limit_changes" ADD CONSTRAINT "budget_limit_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_limit_changes" ADD CONSTRAINT "budget_limit_changes_limit_id_budget_limits_id_fk" FOREIGN KEY ("limit_id") REFERENCES "public"."budget_limits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_limits" ADD CONSTRAINT "budget_limits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_limit_changes_company_limit_idx" ON "budget_limit_changes" USING btree ("company_id","limit_id");--> statement-breakpoint
CREATE INDEX "budget_limit_changes_company_at_idx" ON "budget_limit_changes" USING btree ("company_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_limits_company_level_ref_uq" ON "budget_limits" USING btree ("company_id","level","ref");--> statement-breakpoint
CREATE INDEX "budget_limits_company_level_idx" ON "budget_limits" USING btree ("company_id","level");--> statement-breakpoint
