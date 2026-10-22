ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "resurrection_count" integer DEFAULT 0 NOT NULL;
