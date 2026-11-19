ALTER TABLE "agent_castes" ADD COLUMN "step_model_rules" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "step_class" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "step_model_group" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "step_model" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "step_model_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "step_model_snapshot_json" jsonb;