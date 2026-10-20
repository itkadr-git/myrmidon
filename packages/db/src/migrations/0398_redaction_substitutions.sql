CREATE TABLE IF NOT EXISTS "redaction_substitutions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "redaction_id" uuid NOT NULL,
  "token" text NOT NULL,
  "original" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "redaction_substitutions_lookup_idx" ON "redaction_substitutions" ("redaction_id", "token");
CREATE INDEX IF NOT EXISTS "redaction_substitutions_expiry_idx" ON "redaction_substitutions" ("expires_at");
