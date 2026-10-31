-- C-MEM: journal of the memory sync of execution sites (site hindsight-work -> fleet-work-replica).
CREATE TABLE "myrmidon_fleet_memory_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"target_bank" text NOT NULL,
	"bot_key" text,
	"move_id" uuid,
	"archive_bytes" bigint,
	"documents_imported" integer,
	"documents_skipped" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_memory_syncs" ADD CONSTRAINT "myrmidon_fleet_memory_syncs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "myrmidon_fleet_memory_syncs_site_started_idx" ON "myrmidon_fleet_memory_syncs" USING btree ("company_id","site_name","started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_fleet_memory_syncs_running_site_uq" ON "myrmidon_fleet_memory_syncs" USING btree ("company_id","site_name") WHERE "myrmidon_fleet_memory_syncs"."status" = 'running';
