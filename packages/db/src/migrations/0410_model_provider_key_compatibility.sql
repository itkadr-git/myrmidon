-- OPE-7199: provider key metadata and persisted tool-call compatibility state.
ALTER TABLE "model_providers"
  ADD COLUMN "expires_at" timestamp with time zone,
  ADD COLUMN "rpm_limit" integer,
  ADD COLUMN "package_name" text,
  ADD COLUMN "tool_call_compatible" boolean,
  ADD COLUMN "tool_call_checked_at" timestamp with time zone,
  ADD COLUMN "tool_call_check_error" text;
--> statement-breakpoint
ALTER TABLE "model_providers"
  ADD CONSTRAINT "model_providers_rpm_limit_check"
  CHECK ("rpm_limit" IS NULL OR "rpm_limit" > 0);
