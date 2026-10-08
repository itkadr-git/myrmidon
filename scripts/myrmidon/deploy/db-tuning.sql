-- DB-TUNING (OPE-5009): the PostgreSQL settings from the database audit
-- (OPE-4270, the 06.10 measurement: ~240 000 s of DB CPU in 3 days, the top
-- being heartbeat_runs queries — 334k calls x 269 ms, 11.7k x 5.5 s, 444 x
-- 21.5 s; the table grew 1172 -> 1459 MB).
--
-- This file is the DECLARATIVE source of the settings: it is applied by
-- deploy.sh through DB_TUNE_COMMAND (see deploy.env.example), never by hand
-- with ALTER SYSTEM on the server. The reset lives in db-tuning-rollback.sql
-- and is applied by rollback.sh through DB_TUNE_ROLLBACK_COMMAND. The table
-- names below match the drizzle schema in packages/db/src/schema/
-- (heartbeat_runs, agent_wakeup_requests, company_secrets, issues).
--
-- jit = off: the audit found JIT compiling cheap repeated plans (the board's
--   hot queries plan in tens of ms; JIT added overhead, never saved anything).
-- work_mem = 16MB: sorts/hash joins spilled to disk at the 4MB default.
-- wal_compression = lz4: less WAL bytes for the write-heavy run tables.
-- autovacuum_vacuum_scale_factor = 0.05 (server default): the hot tables
--   churn faster than the 0.2 default tolerates; dead tuples accumulate
--   between vacuums and every scan walks them.
-- per-table 0.02 for the three hottest tables (the audit's top CPU consumers
--   and the fastest growers) and autovacuum_analyze_scale_factor = 0.02 for
--   issues so its statistics stay fresh.

ALTER SYSTEM SET jit = off;
ALTER SYSTEM SET work_mem = '16MB';
ALTER SYSTEM SET wal_compression = 'lz4';
ALTER SYSTEM SET autovacuum_vacuum_scale_factor = 0.05;
ALTER TABLE heartbeat_runs SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE agent_wakeup_requests SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE company_secrets SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE issues SET (autovacuum_analyze_scale_factor = 0.02);
SELECT pg_reload_conf();
