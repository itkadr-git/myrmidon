-- DB-TUNING-HINDSIGHT (OPE-12680): the reset of db-tuning-hindsight.sql.
-- Applied the same way as the apply script (psql -U postgres -d
-- myrmidon_hindsight: the tables belong to role myrmidon_hindsight, not to the
-- board role); per-table reloptions return to the server-wide values — this
-- file does NOT touch ALTER SYSTEM. RESET of an option that was never set is a
-- no-op, so the script is safe to run twice or after a partial apply (it also
-- clears cost_limit / cost_delay set by hand).
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
