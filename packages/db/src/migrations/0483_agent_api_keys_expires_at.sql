ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
