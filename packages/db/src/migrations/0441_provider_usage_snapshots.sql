CREATE TABLE "provider_usage_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "credential_ref" text NOT NULL,
  "window_kind" text NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "resets_at" timestamp with time zone NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "used" jsonb NOT NULL,
  "limits" jsonb NOT NULL,
  "source_event_id" text NOT NULL,
  "owner_issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_usage_snapshots_window_uq" ON "provider_usage_snapshots" USING btree ("company_id", "provider", "credential_ref", "window_kind", "window_started_at");
--> statement-breakpoint
CREATE INDEX "provider_usage_snapshots_company_observed_idx" ON "provider_usage_snapshots" USING btree ("company_id", "observed_at");
--> statement-breakpoint
CREATE TABLE "provider_usage_event_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "event_id" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_usage_event_receipts_company_event_uq" ON "provider_usage_event_receipts" USING btree ("company_id", "event_id");
