-- myrmidon(SERVER-ONBOARD A): additive columns on the fleet registry and the
-- onboard-job table. The registry keeps only secret NAMES; values live in the
-- panel secret store. Idempotent so a partially-migrated instance re-runs safe.

ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN IF NOT EXISTS "onboard_state" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN IF NOT EXISTS "host_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN IF NOT EXISTS "access_key_secret_key" text;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN IF NOT EXISTS "bootstrap_version" text;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN IF NOT EXISTS "last_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD COLUMN IF NOT EXISTS "last_check_ok" boolean;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "myrmidon_fleet_servers" DROP CONSTRAINT IF EXISTS "myrmidon_fleet_servers_role_check";
  ALTER TABLE "myrmidon_fleet_servers" ADD CONSTRAINT "myrmidon_fleet_servers_role_check" CHECK ("role" in ('generic', 'build-runner', 'sandbox', 'bot-host'));
  ALTER TABLE "myrmidon_fleet_servers" DROP CONSTRAINT IF EXISTS "myrmidon_fleet_servers_onboard_state_check";
  ALTER TABLE "myrmidon_fleet_servers" ADD CONSTRAINT "myrmidon_fleet_servers_onboard_state_check" CHECK ("onboard_state" in ('new', 'onboarding', 'ready', 'needs_attention', 'decommissioned'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "myrmidon_fleet_onboard_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text DEFAULT 'onboard' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"step" text,
	"step_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "myrmidon_fleet_onboard_jobs_kind_check" CHECK ("kind" in ('onboard', 'recheck', 'decommission')),
	CONSTRAINT "myrmidon_fleet_onboard_jobs_status_check" CHECK ("status" in ('pending', 'claimed', 'running', 'succeeded', 'failed', 'expired'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "myrmidon_fleet_onboard_jobs_company_idx" ON "myrmidon_fleet_onboard_jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "myrmidon_fleet_onboard_jobs_server_idx" ON "myrmidon_fleet_onboard_jobs" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "myrmidon_fleet_onboard_jobs_server_open_uq" ON "myrmidon_fleet_onboard_jobs" ("server_id") WHERE "status" in ('pending', 'claimed', 'running');--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "myrmidon_fleet_onboard_jobs" ADD CONSTRAINT "myrmidon_fleet_onboard_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	ALTER TABLE "myrmidon_fleet_onboard_jobs" ADD CONSTRAINT "myrmidon_fleet_onboard_jobs_server_id_myrmidon_fleet_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."myrmidon_fleet_servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
