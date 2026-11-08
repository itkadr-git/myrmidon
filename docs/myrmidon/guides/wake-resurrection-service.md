# Wake Resurrection Service

The Wake Resurrection Service handles the reprocessing of skipped agent wakeups with the reason `execution_reconciliation_required`. When an agent wakeup is rejected during execution reconciliation, the system will attempt to resurrect it once after the reconciliation is complete.

## Configuration

No additional configuration is required. The service operates automatically when execution reconciliation occurs.

## Behavior

- Skipped wakeups with reason `execution_reconciliation_required` are retried once after reconciliation
- Wakeups with `evidence.automaticRecovery.replay="blocked"` are not resurrected
- Each wakeup is limited to one resurrection attempt
- Resurrection attempts are tracked via the `resurrection_count` field in the database

## Technical Details

- The resurrection is inline in the run-dispatch Postgres adapter, at the point where a wakeup is set to `skipped` with `execution_reconciliation_required`: a new pending wakeup is enqueued with a fresh idempotency key and `resurrection_count + 1`
- A database migration adds the `resurrection_count` column to the `agent_wakeup_requests` table
- `ResurrectionService` (`server/src/myrmidon/resurrection-service.ts`) is the manual and diagnostic entry point over the same rule
