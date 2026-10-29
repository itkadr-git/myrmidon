ALTER TABLE "knowledge_suggestions" ADD COLUMN IF NOT EXISTS "recommendation" text DEFAULT 'accepted' NOT NULL;
