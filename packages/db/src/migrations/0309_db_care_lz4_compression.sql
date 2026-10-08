-- myrmidon(DB-CARE / DBC-2): three varlena columns of heartbeat_runs carry the
-- largest payloads of the table (the run context snapshot, the structured run
-- result and the captured stdout tail). The datastore audit of 07-08.10.2026
-- switched them to the lz4 compression method on the production board database:
-- lz4 compresses and decompresses markedly faster than the default pglz, and the
-- audit measured the write and read cost of these columns on the run hot path.
-- This migration repeats the change for every installation.
--
-- ALTER TABLE ... ALTER COLUMN ... SET COMPRESSION is a catalog-only change: it
-- takes a short ACCESS EXCLUSIVE lock, rewrites no rows, and applies to the rows
-- written after it; the rows already stored keep their method until they are
-- rewritten. On the production instance the three columns already carry 'l', so
-- the statements are no-ops there.
--
-- The procedural block is deliberate. PostgreSQL exposes no catalog view of the
-- available compression methods: lz4 exists only in builds configured with
-- --with-lz4, and every other build rejects the statement. A plain statement
-- would therefore stop the whole migration chain on such a server (the project's
-- own embedded-Postgres test harness is one) for a storage tuning that is not a
-- correctness requirement. The block tries the method and keeps the current one
-- when the build cannot offer it, and it says so through a notice in the deploy
-- log. The intent of the change is still visible in the statement below.
DO $$
BEGIN
  ALTER TABLE "heartbeat_runs" ALTER COLUMN "context_snapshot" SET COMPRESSION lz4;
  ALTER TABLE "heartbeat_runs" ALTER COLUMN "result_json" SET COMPRESSION lz4;
  ALTER TABLE "heartbeat_runs" ALTER COLUMN "stdout_excerpt" SET COMPRESSION lz4;
EXCEPTION WHEN feature_not_supported THEN
  RAISE NOTICE 'lz4 compression is not available on this server; heartbeat_runs keeps the current compression method';
END $$;