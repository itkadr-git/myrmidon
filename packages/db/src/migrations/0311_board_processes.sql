-- myrmidon(PROCS-0.1): the board-process registry (OPE-5394 §5.1, этап 0).
-- One row per live board process, keyed by boot; pulsed every 10 s with
-- last_seen_at/event_loop_lag_ms/rss_bytes, cleaned up past 2 minutes stale.
-- Instance-scoped (not per-company): in single-process mode it holds one row.
CREATE TABLE IF NOT EXISTS "board_processes" (
	"boot_id" uuid PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'single' NOT NULL,
	"pid" integer NOT NULL,
	"hostname" text NOT NULL,
	"container" text,
	"version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"api_port" integer NOT NULL,
	"event_loop_lag_ms" integer,
	"rss_bytes" bigint
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_processes_last_seen_idx" ON "board_processes" USING btree ("last_seen_at");
