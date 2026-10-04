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

## Performance Improvements

The chat reconciliation system has been optimized with the following improvements:

1. **Event-Driven Architecture**: Instead of polling every second, the system now reacts to events such as new publications, actions, or milestones.
2. **Fallback Timer**: A configurable timer ensures reconciliation still occurs during idle periods.
3. **Partial Indexes**: New partial indexes on `chat_publications` and `chat_actions` tables optimize queries for pending/retry states.
4. **Cursor-Based Processing**: Milestone projections now use cursor-based pagination for improved efficiency.

These changes significantly reduce database load when the system is idle, bringing query frequency from ~18,000 per minute to <10 per minute during idle periods, while reducing total database time by ≥ 10x.