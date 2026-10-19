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
--> statement-breakpoint
-- myrmidon(1.6.6): every existing company gets the accepted fleet registry baseline.
INSERT INTO "myrmidon_fleet_sites" (
  "company_id", "slug", "fleetd_url", "label", "region", "capacity_cpu", "capacity_ram_gb", "status"
)
SELECT c."id", 'myr-vm1',
  'https://10' || '.' || '10' || '.' || '0' || '.' || '110' || ':8444',
  'Myrmidon VM 1', 'remote', 6, 24, 'enabled'
FROM "companies" c
ON CONFLICT ("company_id", "slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "myrmidon_fleet_sites" (
  "company_id", "slug", "fleetd_url", "label", "region", "capacity_cpu", "capacity_ram_gb", "status"
)
SELECT c."id", 'vm-local', 'http://localhost:8444', 'Local Docker', 'local', 1, 1, 'enabled'
FROM "companies" c
ON CONFLICT ("company_id", "slug") DO NOTHING;
