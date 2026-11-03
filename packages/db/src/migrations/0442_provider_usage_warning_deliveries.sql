CREATE TABLE "provider_usage_warning_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "owner_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "warning_key" text NOT NULL,
  "body" text NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_usage_warning_deliveries_warning_uq" ON "provider_usage_warning_deliveries" USING btree ("company_id", "warning_key");
--> statement-breakpoint
CREATE INDEX "provider_usage_warning_deliveries_pending_idx" ON "provider_usage_warning_deliveries" USING btree ("next_attempt_at", "delivered_at");