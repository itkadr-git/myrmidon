CREATE TABLE IF NOT EXISTS "llm_call_traces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "heartbeat_run_id" uuid NOT NULL REFERENCES "heartbeat_runs"("id") ON DELETE cascade,
  "issue_id" uuid,
  "langfuse_trace_id" text,
  "langfuse_observation_id" text,
  "litellm_request_id" text,
  "provider" text,
  "model" text,
  "tools_rev" text,
  "tool_count" integer,
  "system_chars" bigint,
  "system_tokens" integer,
  "tools_chars" bigint,
  "tools_tokens" integer,
  "wake_chars" bigint,
  "wake_tokens" integer,
  "history_chars" bigint,
  "history_tokens" integer,
  "tool_results_chars" bigint,
  "tool_results_tokens" integer,
  "total_chars" bigint,
  "total_tokens" integer,
  "prompt_tokens" integer DEFAULT 0 NOT NULL,
  "cached_prompt_tokens" integer DEFAULT 0 NOT NULL,
  "completion_tokens" integer DEFAULT 0 NOT NULL,
  "cost_micro_usd" bigint,
  "compacted" integer DEFAULT 0 NOT NULL,
  "pre_compact_chars" bigint,
  "post_compact_chars" bigint,
  "inferred_from_run" integer DEFAULT 0 NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_traces_company_agent_occurred_idx" ON "llm_call_traces" USING btree ("company_id","agent_id","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_traces_company_occurred_idx" ON "llm_call_traces" USING btree ("company_id","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_traces_company_model_occurred_idx" ON "llm_call_traces" USING btree ("company_id","model","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_traces_run_idx" ON "llm_call_traces" USING btree ("heartbeat_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_traces_unique_observation" ON "llm_call_traces" USING btree ("company_id","langfuse_observation_id");
