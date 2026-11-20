-- Drizzle runs migrations in a transaction, so CONCURRENTLY cannot be used here.
-- These indexes are redundant for the secret screen, which is served by company_created_idx.
DROP INDEX IF EXISTS "secret_access_events_secret_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "secret_access_events_company_credential_owner_idx";
