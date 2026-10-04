# Fix: Optimize heartbeat_runs query for watchdog performance

## Summary
This PR addresses the critical performance issue where the active-run watchdog was executing a slow query against the `heartbeat_runs` table, consuming excessive CPU resources (420-440% CPU on 04.10).

## Problem
- Query to `heartbeat_runs` with filters on `company_id + runtime_mode` and OR conditions was causing high CPU usage
- 34,584 calls averaging 2.4 seconds each, totaling ~84,000 seconds of CPU time
- Table has 22k rows, 1.1 GB with no index on `runtime_mode` and JSON conditions
- Query execution time was far exceeding the required < 50ms threshold

## Solution
Added optimized indices to support the watchdog query pattern in `server/src/modules/active-run-watchdog/adapters/postgres.ts`:

1. `heartbeat_runs_watchdog_candidate_idx` - Index on `(company_id, status, runtime_mode, created_at)` with condition `WHERE status = 'running'`
2. `heartbeat_runs_watchdog_timestamps_idx` - Index on timestamps with coalesce for efficient time-based filtering
3. `heartbeat_runs_running_status_idx` - Partial index on `(company_id, created_at)` for running runs only
4. `heartbeat_runs_runtime_status_idx` - Index for filtering by `(company_id, runtime_mode, status)` with condition `WHERE status = 'running'`

## Performance Impact
- Expected query execution time reduction from 2.4 seconds to < 50 milliseconds
- CPU utilization reduction from 420-440% to < 50%
- Improved overall system responsiveness

## Changes
- Added migration file `packages/db/src/migrations/0296_watchdog_query_performance.ts` with index creation
- Added documentation explaining the performance fix
- Added test script to verify performance improvements

## Testing
The migration is backward-compatible and can be safely applied to production. Indices will be created without table locks that would impact availability.