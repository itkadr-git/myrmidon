-- DB-TUNING (OPE-5009): the reset of db-tuning.sql. Applied by rollback.sh
-- through DB_TUNE_ROLLBACK_COMMAND (see deploy.env.example) — the declarative
-- counterpart of the apply, never run by hand on the server.
--
-- ALTER SYSTEM RESET removes the line from postgresql.auto.conf, so the
-- parameter returns to its compiled/postgresql.conf default — exactly the
-- value the server had before the first managed deploy. The per-table
-- autovacuum options are reset the same way (ALTER TABLE ... RESET returns
-- them to the server settings). pg_reload_conf() re-reads the configuration
-- without a restart; none of the settings here need a restart.

ALTER SYSTEM RESET jit;
ALTER SYSTEM RESET work_mem;
ALTER SYSTEM RESET wal_compression;
ALTER SYSTEM RESET autovacuum_vacuum_scale_factor;
ALTER TABLE heartbeat_runs RESET (autovacuum_vacuum_scale_factor);
ALTER TABLE agent_wakeup_requests RESET (autovacuum_vacuum_scale_factor);
ALTER TABLE company_secrets RESET (autovacuum_vacuum_scale_factor);
ALTER TABLE issues RESET (autovacuum_analyze_scale_factor);
SELECT pg_reload_conf();
