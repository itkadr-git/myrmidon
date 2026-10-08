-- myrmidon(DB-CARE / DBC-2): three varlena columns of heartbeat_runs carry the
-- largest payloads of the table (the run context snapshot, the structured run
-- result and the captured stdout tail). The datastore audit of 07-08.10.2026
-- switched them to the lz4 compression method on the production board database:
-- lz4 compresses and decompresses markedly faster than the default pglz, and
-- the audit measured the write and read cost of these columns on the run hot
-- path. This migration repeats the change for every installation.
--
-- ALTER TABLE ... ALTER COLUMN ... SET COMPRESSION is a catalog-only change: it
-- takes a short ACCESS EXCLUSIVE lock, rewrites no rows, and applies to the
-- rows written after it; the rows already stored keep their method until they
-- are rewritten. On the production instance the three columns already carry
-- 'l', so the statements are no-ops there.
ALTER TABLE "heartbeat_runs" ALTER COLUMN "context_snapshot" SET COMPRESSION lz4;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ALTER COLUMN "result_json" SET COMPRESSION lz4;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ALTER COLUMN "stdout_excerpt" SET COMPRESSION lz4;