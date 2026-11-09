CREATE TABLE "reflect_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"job_type" text DEFAULT 'post_task_reflect' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dedup_key" text NOT NULL,
	"event" text DEFAULT 'done' NOT NULL,
	"role" text,
	"assignee_agent_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reflect_jobs" ADD CONSTRAINT "reflect_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflect_jobs" ADD CONSTRAINT "reflect_jobs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflect_jobs" ADD CONSTRAINT "reflect_jobs_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reflect_jobs_company_idx" ON "reflect_jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "reflect_jobs_issue_idx" ON "reflect_jobs" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "reflect_jobs_status_idx" ON "reflect_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reflect_jobs_dedup_key_uniq" ON "reflect_jobs" USING btree ("dedup_key");