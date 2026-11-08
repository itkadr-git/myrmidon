# Heartbeat runs: continuation storage and measurement

This note describes the run-continuation storage and the queries used to inspect `heartbeat_runs`. The figures below are historical audit measurements, not a guarantee for every deployment. Run the read-only queries in `heartbeat_runs_optimization.sql` against a representative database to measure current values.

## Continuation storage

The execution-continuation envelope is stored in `heartbeat_run_continuations`, one row per run. The table includes the envelope, serialized character count, optional wake links, and indexes for unique run lookup and company/agent or company/issue history. `heartbeat_runs.context_snapshot` does not receive the current envelope; its persisted form omits the in-memory top-level `executionContinuation` field. The wake payload is saved without another copy, and dispatch attaches the envelope for the adapter when needed.

For rows written before this storage model, readers retain a fallback to the legacy `context_snapshot.executionContinuation` value. Migration `0330_heartbeat_run_continuations.sql` introduced the table and its indexes. Migration `0380_remove_execution_continuation_duplication.sql` cleans historical duplicate copies between the top-level snapshot field and the nested `paperclipWake.executionContinuation` field. That cleanup applies to legacy snapshot data; it is not a migration of current envelopes into or out of the continuation table.

## Query costs and measurements

The measurement SQL reports snapshot sizes and relation/TOAST sizes, inspects continuation table row/size data, and runs an `EXPLAIN (ANALYZE, BUFFERS)` projection shaped like the heartbeat-run list. The current list projection reads context values from thin columns first and falls back to `context_snapshot` JSON extraction for historical rows where the thin columns are null. This lets rows with populated thin columns avoid detoasting the snapshot. The SQL query shows the JSON-extraction fallback form for illustration; it is not the complete current list projection. The conversation ownership probe uses a narrow projection of the six values it needs, rather than loading the full run row and its JSON columns for each candidate.

The index `heartbeat_runs_company_issue_coalesce_created_idx` supports company and issue lookup using `coalesce(native_issue_id::text, context_snapshot ->> 'issueId')` with descending creation time and id ordering. Confirm the actual plan on a representative database; PostgreSQL may choose a different plan depending on statistics and data distribution.

The continuation storage test is `server/src/services/heartbeat-run-continuations.myrmidon.test.ts`. From the repository root, run:

```sh
pnpm --filter @myrmidon/server exec vitest run src/services/heartbeat-run-continuations.myrmidon.test.ts
```

The SQL contains only `SELECT` statements, including the `EXPLAIN ANALYZE` query. Still use a staging copy or an approved maintenance window for measurements: `EXPLAIN ANALYZE` executes the measured `SELECT` and may consume resources. No live-database execution is claimed here.

## Historical figures

An earlier board-database audit reported approximately 1.1 GB total size for `heartbeat_runs`, including about 1.07 GB of TOAST data, and estimated roughly 354 MB in duplicated continuation payloads. A separate sample found average snapshot sizes of about 30.7 KB overall and 7.58 KB for completed rows. These values predate the dedicated continuation table and historical cleanup; do not treat them as current post-migration measurements. Re-run the supplied queries to establish a current baseline.

## Risks and interpretation

- Legacy rows may still require the snapshot fallback until their data is available through the new table; do not remove compatibility reads without separate verification.
- The historical cleanup migration preserves the top-level copy where present, or lifts a nested value when the top-level copy is absent, before removing nested duplicates. Review the migration source for the exact row conditions.
- The measurements depend on database size, PostgreSQL statistics, and cache state. Compare like-for-like runs and record the environment separately.

## Source references

The original measurement SQL attachment is `/api/attachments/f1feff8d-121f-4fde-a71f-c7548c9f0234/content`; the original English notes attachment is `/api/attachments/fc7fc0b4-b4ed-41f1-8b6c-32233fe371fe/content`. These source drafts predate the current implementation and were reconciled against the repository before publication.
