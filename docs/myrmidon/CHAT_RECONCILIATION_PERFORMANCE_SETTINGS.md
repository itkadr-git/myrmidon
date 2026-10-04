# Chat Reconciliation Performance Settings

This document describes the performance-related settings for chat reconciliation in Myrmidon.

## Environment Variables

### `MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS`

Controls the fallback interval for chat reconciliation when no events occur. This replaces the old polling mechanism with an event-driven approach that has a configurable fallback timer.

- **Type**: Integer (milliseconds)
- **Default**: 30000 (30 seconds)
- **Description**: Maximum time between reconciliation passes when no events trigger reconciliation. The system uses an event-driven approach where possible, but this ensures regular reconciliation occurs during idle periods.
- **Usage**: Set this to control how often the system performs reconciliation when there are no new publications, actions, or milestones to process.

Example:
```
MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS=60000  # 60 seconds
```

## Behavior

1. Publication and milestone commit signals wake their lanes directly (event-driven).
2. The full reconciliation pass (provider runtimes, deliveries, webhook recovery, Slack syncs) runs only on the fallback timer instead of once per second; its first pass still runs at startup.
3. Migration 0296 adds partial indexes on `chat_publications` (pending/retry/streaming work) and `chat_actions` (received/processing work) and a `heartbeat_runs (company_id, status, updated_at)` index. The migration builds them without CONCURRENTLY (migrations run in a transaction); on a large live table create them by hand with CONCURRENTLY first, the migration is then a no-op.
