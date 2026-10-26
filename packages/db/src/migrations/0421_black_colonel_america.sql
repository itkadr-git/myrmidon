CREATE TABLE "myrmidon_fleet_onboard_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text DEFAULT 'onboard' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"step" text,
	"step_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_consumed_at" timestamp with time zone,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "myrmidon_fleet_onboard_jobs_kind_check" CHECK ("myrmidon_fleet_onboard_jobs"."kind" in ('onboard', 'recheck', 'decommission')),
	CONSTRAINT "myrmidon_fleet_onboard_jobs_status_check" CHECK ("myrmidon_fleet_onboard_jobs"."status" in ('pending', 'claimed', 'running', 'succeeded', 'failed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN "keep_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN "role" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN "onboard_state" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN "host_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN "access_key_secret_key" text;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN "bootstrap_version" text;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN "last_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN "last_check_ok" boolean;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_onboard_jobs" ADD CONSTRAINT "myrmidon_fleet_onboard_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_onboard_jobs" ADD CONSTRAINT "myrmidon_fleet_onboard_jobs_server_id_myrmidon_fleet_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."myrmidon_fleet_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "myrmidon_fleet_onboard_jobs_company_idx" ON "myrmidon_fleet_onboard_jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "myrmidon_fleet_onboard_jobs_server_idx" ON "myrmidon_fleet_onboard_jobs" USING btree ("server_id");--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD CONSTRAINT "myrmidon_fleet_servers_role_check" CHECK ("myrmidon_fleet_servers"."role" in ('generic', 'build-runner', 'sandbox', 'bot-host'));--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD CONSTRAINT "myrmidon_fleet_servers_onboard_state_check" CHECK ("myrmidon_fleet_servers"."onboard_state" in ('new', 'onboarding', 'ready', 'needs_attention', 'decommissioned'));