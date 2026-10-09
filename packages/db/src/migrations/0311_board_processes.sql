-- myrmidon(1.6.6 PROCS-0.1, design BOARD-PROCESSES §5.1): the process registry
-- of the board — one row per running board process, refreshed by a 10 s pulse;
-- rows older than 2 min are reaped by the leader. Additive only: one new table
-- plus one index, no vendor table touched, no data rewritten
-- (generated with drizzle-kit).
CREATE TABLE "board_processes" (
	"boot_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"pid" integer NOT NULL,
	"hostname" text NOT NULL,
	"container" text,
	"version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"api_port" integer,
	"event_loop_lag_ms" integer,
	"rss_bytes" bigint
);
--> statement-breakpoint
CREATE INDEX "board_processes_last_seen_idx" ON "board_processes" USING btree ("last_seen_at");
