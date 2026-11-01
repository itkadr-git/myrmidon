# PostgreSQL retention space reclamation

The data-retention sweep deletes rows in bounded transactions while the board is live. It does not run `VACUUM FULL`, `pg_repack`, or another operation that takes an exclusive table lock.

After retention has completed successfully and the database growth measurement confirms that the old rows are no longer needed, reclaim physical disk space in a scheduled maintenance window:

1. Announce maintenance and stop or drain board writers and retention workers. Keep the PostgreSQL backup and restore path available.
2. Confirm the target database and table sizes with `pg_total_relation_size`, and verify there are no active board requests that must write to the target tables.
3. Prefer `pg_repack` when it is installed and the operator has validated its extension and disk headroom. Run it one table at a time, starting with the largest retained table. Do not run it from the application process.
4. If `pg_repack` is unavailable, use `VACUUM (FULL, ANALYZE)` one table at a time. This needs additional temporary disk space and an exclusive lock; abort rather than risk filling the volume.
5. Recheck relation sizes and free disk space, then resume writers and the retention scheduler. Record the commands, duration, and before/after sizes in the maintenance change.

Do not place physical-space reclamation in the live retention sweep. Row deletion and physical compaction have different lock, disk, and rollback characteristics; combining them would make statement-timeout recovery unsafe.
