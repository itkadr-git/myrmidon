CREATE TABLE "bot_apply_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bot_apply_jobs" ADD CONSTRAINT "bot_apply_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_apply_jobs" ADD CONSTRAINT "bot_apply_jobs_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_apply_jobs_company_bot_idx" ON "bot_apply_jobs" USING btree ("company_id","bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_apply_jobs_live_bot_uniq" ON "bot_apply_jobs" USING btree ("bot_id") WHERE "bot_apply_jobs"."status" in ('pending', 'running');
