# Fix: Optimize heartbeat_runs query for watchdog performance

## Problem
The active-run watchdog was executing a slow query against the `heartbeat_runs` table that was consuming excessive CPU resources. According to pg_stat_statements data from 04.10:
- Query to `heartbeat_runs` with filters on `company_id + runtime_mode` and OR conditions
- Using `runner_profile_json->...->>... IN (values)`, `result_json->>... = ...`, `exists(select ... from heartbeat_run_events ...)`, and subquery to `environment_leases`
- 34,584 calls averaging 2.4 seconds each, totaling ~84,000 seconds of CPU time
- `heartbeat_runs` table has 22k rows, 1.1 GB with no index on `runtime_mode` and JSON conditions
- Second place: `context_snapshot` query from `heartbeat_runs` where `company_id, agent_id, status in (...)` - 11k calls at 0.5s each

## Root Cause
The query in `server/src/modules/active-run-watchdog/adapters/postgres.ts` in the `findCandidateSilentRuns` method was scanning the entire `heartbeat_runs` table without appropriate indices. The query filters by `status = 'running'` and uses a complex `coalesce` expression to compare timestamps, but lacked proper indexing.

## Solution
Added optimized indices to support the watchdog query pattern:

1. `heartbeat_runs_watchdog_candidate_idx` - Index on `(company_id, status, runtime_mode, created_at)` with condition `WHERE status = 'running'`
2. `heartbeat_runs_watchdog_timestamps_idx` - Index on timestamps with coalesce for efficient time-based filtering
3. `heartbeat_runs_running_status_idx` - Partial index on `(company_id, created_at)` for running runs only
4. `heartbeat_runs_runtime_status_idx` - Index for filtering by `(company_id, runtime_mode, status)` with condition `WHERE status = 'running'`

These indices specifically target the query patterns used by the watchdog service to find candidate silent runs efficiently.

## Performance Impact
- Expected query execution time reduction from 2.4 seconds to < 50 milliseconds
- CPU utilization reduction from 420-440% to < 50%
- Reduced I/O operations due to efficient index usage

## Migration
The migration is backward-compatible and can be safely applied to production. Indices will be created without table locks that would impact availability.

## Testing
Added performance test to verify query execution time meets the < 50ms requirement after applying the indices.