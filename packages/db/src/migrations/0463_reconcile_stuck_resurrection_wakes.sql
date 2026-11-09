-- myrmidon(OPE-12347): one-time product-path cleanup of stranded
-- resurrection wakes. The pre-fix producer wrote these rows with
-- status "pending" — a status outside WAKEUP_REQUEST_STATUSES that no
-- scheduler reads (release drain, stranded-wake reconcile and terminal
-- cleanup all key off "queued"/"deferred_issue_execution"/"claimed").
-- The rows stranded forever and the idle watchdog miscounted the agent
-- as holding pending work. This migration moves each stranded row into
-- the ordinary deferred queue (status "deferred_issue_execution" scoped
-- by payload ->> 'issueId', no executionWait marker), matching the
-- post-fix producer contract in
-- server/src/myrmidon/resurrection-service.ts and
-- server/src/modules/run-dispatch/adapters/postgres.ts; those rows are
-- then served by the bounded existing paths (release-drain promotion
-- once the issue lock is free; stranded-wake reconcile cancels on a
-- terminal task or expires after 30 minutes and re-wakes the agent).
-- Rows without a usable issue scope could never be served by any path;
-- they are closed terminally as "failed" with the cause in "error" so
-- no pending residue remains.

UPDATE agent_wakeup_requests AS w
SET status = 'deferred_issue_execution',
    updated_at = NOW()
WHERE w.status = 'pending'
  AND w.reason = 'resurrection_execution_reconciliation_required'
  AND NULLIF(w.payload ->> 'issueId', '') IS NOT NULL;

UPDATE agent_wakeup_requests AS w
SET status = 'failed',
    finished_at = NOW(),
    error = 'resurrection_wake_without_issue_scope',
    updated_at = NOW()
WHERE w.status = 'pending'
  AND w.reason = 'resurrection_execution_reconciliation_required'
  AND NULLIF(w.payload ->> 'issueId', '') IS NULL;
