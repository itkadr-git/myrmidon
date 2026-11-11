-- DB-TUNING-HINDSIGHT (OPE-12680): the reset of db-tuning-hindsight.sql.
-- Applied the same way as the apply script (psql -d myrmidon_hindsight);
-- per-table reloptions return to the server-wide values db-tuning.sql
-- (OPE-5009) manages — this file does NOT touch ALTER SYSTEM.
\set ON_ERROR_STOP on

ALTER TABLE memory_units RESET (
    autovacuum_vacuum_scale_factor,
    autovacuum_vacuum_threshold,
    autovacuum_analyze_scale_factor,
    autovacuum_vacuum_cost_limit,
    autovacuum_vacuum_cost_delay,
    toast.autovacuum_vacuum_scale_factor,
    toast.autovacuum_vacuum_threshold,
    toast.autovacuum_vacuum_cost_limit
);

ALTER TABLE memory_links RESET (
    autovacuum_vacuum_scale_factor,
    autovacuum_vacuum_threshold,
    autovacuum_vacuum_insert_scale_factor,
    autovacuum_analyze_scale_factor,
    autovacuum_vacuum_cost_limit,
    autovacuum_vacuum_cost_delay
);
