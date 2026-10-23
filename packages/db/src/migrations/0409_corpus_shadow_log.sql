CREATE TABLE IF NOT EXISTS "corpus_shadow_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ts" timestamp with time zone DEFAULT now() NOT NULL,
  "bot_id" text,
  "dataset" text,
  "query" text,
  "ragflow_chunk_ids" jsonb,
  "ragflow_latency_ms" integer,
  "module_chunk_ids" jsonb,
  "module_latency_ms" integer,
  "module_error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_shadow_log_ts_idx" ON "corpus_shadow_log" ("ts");
