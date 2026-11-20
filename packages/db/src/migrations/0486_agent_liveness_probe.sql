ALTER TABLE "agent_runtime_state" ADD COLUMN "last_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "last_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN "last_probe_outcome" text;