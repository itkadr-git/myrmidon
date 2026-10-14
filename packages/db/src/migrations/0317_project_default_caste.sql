-- myrmidon(PROJECT-DEFAULT-CASTE). Rollback: ALTER TABLE "projects" DROP COLUMN IF EXISTS "default_caste_key";
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "default_caste_key" text;
