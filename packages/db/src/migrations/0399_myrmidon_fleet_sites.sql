CREATE TABLE IF NOT EXISTS "myrmidon_fleet_sites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "slug" text NOT NULL,
  "fleetd_url" text NOT NULL,
  "label" text NOT NULL,
  "site_ca_fingerprint" text,
  "region" text,
  "capacity_cpu" real NOT NULL,
  "capacity_ram_gb" real NOT NULL,
  "max_bots" integer,
  "max_run_tokens_min" integer,
  "status" text DEFAULT 'enabled' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "myrmidon_fleet_sites_company_idx" ON "myrmidon_fleet_sites" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "myrmidon_fleet_sites_company_slug_uq" ON "myrmidon_fleet_sites" USING btree ("company_id", "slug");
