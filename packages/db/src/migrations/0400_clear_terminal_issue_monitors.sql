-- myrmidon(OPE-7932): remove persisted schedules from issues already terminal.
-- New transitions clear the execution-policy monitor too; keep the backfill bounded
-- to terminal issues and preserve unrelated execution policy and execution state.
UPDATE issues
SET monitor_next_check_at = NULL,
    monitor_wake_requested_at = NULL
WHERE status IN ('done', 'cancelled')
  AND (monitor_next_check_at IS NOT NULL OR monitor_wake_requested_at IS NOT NULL);