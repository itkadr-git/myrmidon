-- myrmidon(1.6.6 PROCS-1.7 part A, design BOARD-PROCESSES §5): the leader
-- lease table. One row per lease name; the row `leader` carries the current
-- leader's boot id, a monotonically increasing epoch and the lease expiry
-- (clock_timestamp() on the server side). Additive only: one new table, no
-- vendor table touched, no data rewritten.
CREATE TABLE "board_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder_boot_id" text,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"acquired_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
