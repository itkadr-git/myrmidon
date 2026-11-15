# PostgreSQL retention space reclamation

The data-retention sweep deletes rows in bounded transactions while the board is live. It does not run `VACUUM FULL`, `pg_repack`, or another operation that takes an exclusive table lock.

After retention has completed successfully and the database growth measurement confirms that the old rows are no longer needed, reclaim physical disk space in a scheduled maintenance window:

1. Announce maintenance and stop or drain board writers and retention workers. Keep the PostgreSQL backup and restore path available.
2. Confirm the target database and table sizes with `pg_total_relation_size`, and verify there are no active board requests that must write to the target tables.
3. Prefer `pg_repack` when it is installed and the operator has validated its extension and disk headroom. Run it one table at a time, starting with the largest retained table. Do not run it from the application process.
4. If `pg_repack` is unavailable, use `VACUUM (FULL, ANALYZE)` one table at a time. This needs additional temporary disk space and an exclusive lock; abort rather than risk filling the volume.
5. Recheck relation sizes and free disk space, then resume writers and the retention scheduler. Record the commands, duration, and before/after sizes in the maintenance change.

Do not place physical-space reclamation in the live retention sweep. Row deletion and physical compaction have different lock, disk, and rollback characteristics; combining them would make statement-timeout recovery unsafe.

## Per-table autovacuum tuning: `execution_workspaces` (OPE-13054)

Background: the 2026-11-13 datastore audit flagged `execution_workspaces` at 16.4 % dead tuples (threshold ≤ 10 %) while the global `autovacuum_vacuum_scale_factor` / `autovacuum_analyze_scale_factor` stay above the section-6 target (≤ 0.05), so autovacuum reaches this churny table too rarely. See `server/src/myrmidon/datastore-care/audit-report.ts` (criterion `dead-tuples`, threshold `≤ 10 %`) for how the number is measured: `pg_stat_user_tables.n_dead_tup / (n_live_tup + n_dead_tup)`.

Root cause (measured 2026-11-13): the table is small (123 live rows / 24 dead) and every heartbeat run start mutates it — the reuse path writes `status = 'active'`, `last_used_at = now()`, `metadata`, and `project_workspace_id` per run (`server/src/services/heartbeat.ts` ~26211), the former shared-workspace row flips to `idle` when a new run takes the workspace (~26345), run finalization archives terminal-issue workspaces and stamps `cleanup_eligible_at` / `cleanup_reason` / lifecycle-generation metadata (`execution-workspaces.ts` ~2874), the terminality reaper retries failed cleanups, and the same service writes `metadata` stuck-signal throttles and reopen flags. One UPDATE per run on a small table reproduces the 16.4 % ratio; the churn is runtime state, not a leak.

Recommended per-table settings (maintenance window; the table is small, each ALTER is a catalog-only tuple update on `pg_class` — instant, no table rewrite):

```sql
ALTER TABLE execution_workspaces SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay = 0
);
```

Rationale: at 123 live rows the default 20 % factor needs ~25 dead rows to trigger; 0.05 ≈ 6 rows (a few heartbeats). `analyze 0.02` keeps last-used ordering statistics fresh for `DESC last_used_at` collection queries. `cost_delay = 0` lets the small vacuum finish immediately instead of throttling. Do NOT set per-table vacuum thresholds on the big append-heavy tables (issues, issues... ) — they are handled by the retention sweep.

Check afterwards (and weekly):

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_pct,
       last_autovacuum, autovacuum_count
FROM pg_stat_user_tables WHERE relname = 'execution_workspaces';
```

Target: dead-tuple ratio ≤ 10 % with `last_autovacuum` more recent than the settings change, `autovacuum_count` increasing.
