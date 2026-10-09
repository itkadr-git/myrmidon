-- myrmidon(1.6.5 BOARD-PROCESSES stage 0): the process registry of the board —
-- one row per running board process, refreshed by a 10 s pulse; rows older than
-- 2 min are reaped by the leader — and the leader leases table the panel reads.
-- Additive only: two new tables plus one index, no vendor table touched, no
-- data rewritten.
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
CREATE TABLE "board_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder_boot_id" text,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"acquired_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "board_processes_last_seen_idx" ON "board_processes" USING btree ("last_seen_at");
