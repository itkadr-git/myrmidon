-- myrmidon(1.7-GUARDRAILS): persistent hierarchical rule mode overrides.
CREATE TABLE "guardrail_mode_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "level" text NOT NULL,
  "target_id" text NOT NULL,
  "rule" text NOT NULL,
  "mode" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "guardrail_mode_settings_lookup_idx" ON "guardrail_mode_settings" ("company_id", "level", "target_id");
CREATE UNIQUE INDEX "guardrail_mode_settings_rule_uq" ON "guardrail_mode_settings" ("company_id", "level", "target_id", "rule");
