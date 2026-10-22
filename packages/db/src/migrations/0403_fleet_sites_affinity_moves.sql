CREATE TABLE IF NOT EXISTS "myrmidon_fleet_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"token_secret" text,
	"ca_cert" text,
	"ca_cert_fingerprint" text,
	"client_cert_secret_key" text,
	"client_cert_not_after" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"capacity" jsonb DEFAULT '{"maxCpus": 8, "maxMemoryMb": 32768}'::jsonb NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"cert_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "myrmidon_fleet_affinity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"target_id" text NOT NULL,
	"site_name" text NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "myrmidon_fleet_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bot_key" text NOT NULL,
	"src_site" text NOT NULL,
	"dst_site" text NOT NULL,
	"phase" text NOT NULL,
	"phase_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"lease_expires" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "myrmidon_fleet_sites" ADD CONSTRAINT "myrmidon_fleet_sites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "myrmidon_fleet_affinity" ADD CONSTRAINT "myrmidon_fleet_affinity_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "myrmidon_fleet_moves" ADD CONSTRAINT "myrmidon_fleet_moves_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "myrmidon_fleet_sites_company_idx" ON "myrmidon_fleet_sites" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "myrmidon_fleet_sites_company_name_uq" ON "myrmidon_fleet_sites" USING btree ("company_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "myrmidon_fleet_affinity_company_idx" ON "myrmidon_fleet_affinity" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "myrmidon_fleet_affinity_scope_target_idx" ON "myrmidon_fleet_affinity" USING btree ("scope", "target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "myrmidon_fleet_moves_company_bot_idx" ON "myrmidon_fleet_moves" USING btree ("company_id", "bot_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "myrmidon_fleet_moves_phase_idx" ON "myrmidon_fleet_moves" USING btree ("phase");
