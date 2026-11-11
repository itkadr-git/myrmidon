-- DB-TUNING-HINDSIGHT (OPE-12680): per-table autovacuum for the hindsight
-- memory tables in the myrmidon_hindsight database.
--
-- FACTS (11.11, the board host): memory_units 13 GB over 775k rows (658k
-- live / 117k dead), memory_links 9.5 GB over 21.8M rows, database growing
-- ~1.3 GB/day. Live data only accounts for tens of MB/day, so the growth is
-- vacuum-lag bloat: rows are UPDATED in place (access_count / updated_at on
-- recall hits; consolidation rewrites observation facts, and every rewrite of
-- a TOASTed row leaves the old TOAST version dead until vacuum), and the
-- default budget throttles vacuum on a 13 GB heap so dead tuples pile up.
--
-- WHY PER-TABLE: the 09.11 incident showed that touching the GLOBAL
-- autovacuum thresholds during the day slows the whole board (db-tuning.sql,
-- OPE-5009). Everything below is table-scoped reloptions inside the
-- myrmidon_hindsight database only — no ALTER SYSTEM here, other tables and
-- other databases keep the global settings exactly as db-tuning.sql set them.
--
-- WHY THESE VALUES:
-- memory_units: with the server-wide vacuum_scale_factor 0.05 a pass only
--   triggers past ~33k dead rows and the default cost limit (200) crawls on
--   the 13 GB heap + its TOAST; the snapshot caught 117k dead accumulated.
--   0.02 triggers at ~13k; cost_limit 2000 gives the worker a 10x budget so
--   a pass actually finishes. The TOAST table churns hardest (observation
--   rewrites), so it gets its own toast.* reloptions.
-- memory_links: growth is INSERT-driven (~33 links per unit at every retain),
--   so the insert-triggered vacuum matters: insert_scale_factor 0.02 (~436k
--   inserts) keeps visibility-map / freeze maintenance current on a table
--   growing 2 GB per 4 days instead of the 0.2 default (~4.4M inserts).
--
-- APPLY (from the deploy host, declarative counterpart of db-tuning.sql, but
-- against the hindsight database):
--   docker exec -i myrmidon-pg psql -U paperclip -d myrmidon_hindsight \
--     < scripts/myrmidon/deploy/db-tuning-hindsight.sql
-- ALTER TABLE ... SET is a catalog-only change: instant, no table rewrite,
-- no window needed, safe to apply during the day. The reset lives in
-- db-tuning-hindsight-rollback.sql.

\set ON_ERROR_STOP on

ALTER TABLE memory_units SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 500,
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_vacuum_cost_limit = 2000,
    autovacuum_vacuum_cost_delay = 2,
    toast.autovacuum_vacuum_scale_factor = 0.02,
    toast.autovacuum_vacuum_threshold = 500,
    toast.autovacuum_vacuum_cost_limit = 2000
);

ALTER TABLE memory_links SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_vacuum_insert_scale_factor = 0.02,
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_vacuum_cost_limit = 2000,
    autovacuum_vacuum_cost_delay = 2
);

-- VERIFY — reloptions landed (returns both tables plus the units TOAST):
--   SELECT c.relname, c.reloptions
--     FROM pg_class c
--    WHERE c.oid IN ('memory_units'::regclass, 'memory_links'::regclass,
--                    (SELECT reltoastrelid FROM pg_class
--                      WHERE oid = 'memory_units'::regclass));
-- Re-run the sizes snapshot of hindsight-recall-gate.sh on 3 consecutive
-- days: OPE-12680 accepts growth < 200 MB/day.
