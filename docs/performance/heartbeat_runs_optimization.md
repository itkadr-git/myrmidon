# Heartbeat runs: one copy of the execution continuation (PERF-DIET)

Audit of 04.10 on the board database: `heartbeat_runs` had grown to 1.1 GB
(1.07 GB of it TOASTed JSON). `context_snapshot` carried the execution
continuation envelope twice — once at the top level and once inside
`paperclipWake` — at 90-100 KB per copy, about 354 MB of duplicates across the
table. Every statement that measures the weight is in
`docs/performance/heartbeat_runs_optimization.sql`.

## What changed

1. **The continuation envelope is stored once.** The run snapshot no longer
   gets a top-level `executionContinuation`; the envelope lives inside
   `paperclipWake`, which is what the adapters already read
   (`packages/adapter-utils/src/server-utils.ts`). `buildPaperclipWakePayload`
   now takes the envelope explicitly instead of picking it out of the snapshot.
   The wake payload itself is unchanged: it is assembled from memory, so a run
   still receives its continuation.
2. **Readers go through one accessor.** `readExecutionContinuation`
   (server/src/services/execution-continuation.ts) returns the wake-payload copy
   and falls back to the legacy top-level copy for rows the migration has not
   reached yet. It is used by the resume path (`buildExecutionContinuation`),
   the origin-comment tracking and the native completion feedback.
3. **Existing rows are deduplicated by migration**
   (`0303_remove_execution_continuation_duplication.sql`). It moves the
   top-level copy into `paperclipWake` when the payload does not have one yet —
   no envelope is dropped — and then removes the duplicate key. The rewrite
   walks the primary key in batches of 200 rows, so a gigabyte table never gets
   a single table-wide rewrite. The statement is idempotent: a re-run after a
   partial application only touches leftover rows.

## How to verify

Run the measurement file on a copy of the board database (or in the maintenance
window): `docs/performance/heartbeat_runs_optimization.sql`. It reports

- total relation size, TOAST size and the average `pg_column_size(context_snapshot)`
  before and after the migration,
- how many bytes the duplicated top-level envelope occupied, and the payload of
  one run's wake copy after the migration,
- `EXPLAIN (ANALYZE, BUFFERS)` for the run list projection that the hot route
  reads.

The unit guard is `server/src/services/execution-continuation-wake-dedupe.test.ts`
(`pnpm --filter @paperclipai/server exec vitest run src/services/execution-continuation-wake-dedupe.test.ts`):
it pins the canonical wake-payload copy, the legacy fallback, the wake-payload
priority when a row carries both copies, an empty envelope, and the origin
comment ids.

The agent container that prepared this change has neither a database client nor
`docker`, so the numbers below are the audit figures plus the arithmetic they
imply; every statement that produces them is in the SQL file.

| Metric | Before | After (expected) |
|---|---|---|
| `heartbeat_runs` total size | 1.1 GB (1.07 GB TOAST) | about 0.75 GB — one envelope per run instead of two |
| duplicate envelopes | ~354 MB | 0 |
| top-level `executionContinuation` | present on every pre-migration run | removed; a payload without a copy received it first |

## DIVERGENCE

The stored shape of a run snapshot changes (one copy instead of two) — the row is
recorded in the change fragment
`docs/myrmidon/changes/myr-1-6-5-continuation-dedupe.md`.

## Risks and rollback

- Rows whose `paperclipWake` is missing or is not an object keep their envelope
  at the top level and are skipped by the dedupe, so the migration never
  removes the only copy.
- Rollback is a code revert: the accessor still reads a legacy top-level copy,
  so a reverted writer keeps working; the migration itself needs no undo (it only
  removes a duplicate key).