-- Migration to add indices for watchdog performance optimization

-- Index for active run watchdog queries: runtime_mode and status filtering with timestamps
CREATE INDEX IF NOT EXISTS heartbeat_runs_watchdog_candidate_idx 
ON heartbeat_runs (
  company_id, 
  status, 
  runtime_mode, 
  created_at
) WHERE status = 'running';

-- Index for efficient timestamp-based filtering for watchdog scans
CREATE INDEX IF NOT EXISTS heartbeat_runs_watchdog_timestamps_idx 
ON heartbeat_runs (
  company_id, 
  status, 
  coalesce(last_output_at, process_started_at, started_at, created_at)
) WHERE status = 'running';

-- Partial index for running runs to speed up watchdog scans
CREATE INDEX IF NOT EXISTS heartbeat_runs_running_status_idx 
ON heartbeat_runs (
  company_id, 
  created_at
) WHERE status = 'running';

-- Index for runtime mode filtering combined with status
CREATE INDEX IF NOT EXISTS heartbeat_runs_runtime_status_idx 
ON heartbeat_runs (
  company_id,
  runtime_mode,
  status
) WHERE status = 'running';