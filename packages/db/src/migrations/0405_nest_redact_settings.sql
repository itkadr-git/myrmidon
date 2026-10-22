-- myrmidon(1.7-REDACT): per-nest redaction settings.
CREATE TABLE IF NOT EXISTS "nest_redact_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "nest_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "nest_redact_settings_nest_idx" ON "nest_redact_settings" USING btree ("nest_id");
