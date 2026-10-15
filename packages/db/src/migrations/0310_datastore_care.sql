-- myrmidon(DBC-4): datastore care — hourly snapshots and audit reports of the
-- board's own PostgreSQL (server/src/myrmidon/datastore-care/).
-- Additive only: two new myrmidon-owned tables; no vendor table is touched, no
-- data is rewritten. The snapshots and the reports carry their own 90-day
-- retention, pruned by the module's hourly job (MYRMIDON_DATASTORE_CARE_*).
CREATE TABLE "datastore_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"datastore_key" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"size_bytes" bigint NOT NULL,
	"toast_bytes" bigint DEFAULT 0 NOT NULL,
	"index_bytes" bigint DEFAULT 0 NOT NULL,
	"server_version" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datastore_audit_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"datastore_key" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"snapshot_id" uuid,
	"criteria" jsonb NOT NULL,
	"top_queries" jsonb NOT NULL,
	"markdown" text NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "datastore_snapshots_key_captured_idx" ON "datastore_snapshots" USING btree ("datastore_key","captured_at");--> statement-breakpoint
CREATE INDEX "datastore_audit_reports_key_generated_idx" ON "datastore_audit_reports" USING btree ("datastore_key","generated_at");