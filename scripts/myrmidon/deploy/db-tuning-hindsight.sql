-- DB-TUNING-HINDSIGHT (OPE-12680): per-table autovacuum for the hindsight
-- memory tables in the myrmidon_hindsight database.
--
-- FACTS (11.11, the board host): memory_units 13 GB over 775k rows (658k
-- live / 117k dead), memory_links 9.5 GB over 21.8M rows, database growing
-- ~1.3 GB/day. Live data only accounts for tens of MB/day, so the growth is
-- vacuum-lag bloat: rows are UPDATED in place (access_count / updated_at on
-- recall hits; consolidation rewrites observation facts), 99% of those updates
-- are not HOT (n_tup_hot_upd 6k of 810k on 12.11), so every update adds an
-- entry to each index of memory_units (8.3 GB of its 13 GB are indexes, 1.1 GB
-- heap, the rest TOAST), and the dead versions wait for a vacuum.
--
-- WHY PER-TABLE: the 09.11 incident showed that touching the GLOBAL
-- autovacuum thresholds during the day slows the whole board (db-tuning.sql,
-- OPE-5009). Everything below is table-scoped reloptions inside the
-- myrmidon_hindsight database only — no ALTER SYSTEM here, other tables and
-- other databases keep the global settings exactly as they are.
--
-- WHY THESE VALUES:
-- memory_units: the live server-wide autovacuum_vacuum_scale_factor is 0.2
--   (12.11; the 0.05 of db-tuning.sql was reset after the 09.11 incident), so
--   a pass triggers only past ~131k dead rows: the last autovacuum ran on
--   08.11 and 122k dead sit just under the trigger. 0.02 triggers at ~13k
--   dead rows, so the work comes in small frequent passes instead of one huge
--   one. The TOAST table gets its own toast.* reloptions.
-- memory_links: growth is INSERT-driven (~33 links per unit at every retain),
--   so the insert-triggered vacuum matters: insert_scale_factor 0.02 (~440k
--   inserts) keeps visibility-map / freeze maintenance current instead of the
--   0.2 default (~4.4M inserts).
-- NO per-table cost_limit / cost_delay: a per-table cost limit is outside the
--   cost balancing between workers, and the DEFAULT budget already read
--   160-200 MB/s on the 09.11 catch-up and stalled the board for ~6 minutes.
--   A tenfold budget on the two biggest tables would not be background work.
--   The tables keep the server-wide vacuum cost settings.
--
-- THIS IS NOT A DAYTIME CHANGE. ALTER TABLE ... SET is a catalog-only change
-- (instant, no table rewrite), but the new thresholds are crossed at once:
-- memory_units has ~122k dead rows against a ~13k trigger and memory_links
-- ~855k inserts since its last vacuum against a ~440k trigger, so within about
-- 30 s (autovacuum_naptime) autovacuum starts a catch-up pass over both
-- tables and all their indexes (8.3 GB + 7.3 GB) on the same Postgres
-- instance as the board. Apply it in the maintenance window and watch
-- pg_stat_activity ('autovacuum:') and /api/health for 5-10 minutes
-- (rollback: db-tuning-hindsight-rollback.sql, pg_cancel_backend on the pass).
-- To take the catch-up out of the apply, vacuum the two tables by hand first,
-- one at a time, with a low vacuum_cost_delay budget, watching vmstat bi.
--
-- APPLY (operator, in the window; the tables belong to the role
-- myrmidon_hindsight, and the board role "paperclip" is neither the owner nor
-- a superuser, so ALTER TABLE fails for it with "must be owner of table"):
--   docker exec -i myrmidon-pg psql -U postgres -d myrmidon_hindsight \
--     < scripts/myrmidon/deploy/db-tuning-hindsight.sql
-- It is deliberately NOT wired into DB_TUNE_COMMAND of deploy.sh, which
-- targets the board database. The reset lives in
-- db-tuning-hindsight-rollback.sql.

\set ON_ERROR_STOP on

ALTER TABLE memory_units SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 500,
    autovacuum_analyze_scale_factor = 0.02,
    toast.autovacuum_vacuum_scale_factor = 0.02,
    toast.autovacuum_vacuum_threshold = 500
);

ALTER TABLE memory_links SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_vacuum_insert_scale_factor = 0.02,
    autovacuum_analyze_scale_factor = 0.02
);

-- VERIFY — reloptions landed (returns both tables plus the units TOAST):
--   SELECT c.relname, c.reloptions
--     FROM pg_class c
--    WHERE c.oid IN ('memory_units'::regclass, 'memory_links'::regclass,
--                    (SELECT reltoastrelid FROM pg_class
--                      WHERE oid = 'memory_units'::regclass));
-- Re-run the sizes snapshot of hindsight-recall-gate.sh on 3 consecutive
-- days: OPE-12680 accepts growth < 200 MB/day. A plain VACUUM returns space to
-- the free-space map, not to the filesystem: expect growth to stop, not the
-- 13 GB to shrink (that needs REINDEX CONCURRENTLY / pg_repack in a window).
