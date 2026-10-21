# Inbox-lite

## Where in code

- `server/src/services/inbox-dismissals.ts:7` defines `inboxDismissalService` over the `inboxDismissals` table.
- `server/src/services/attention.ts` builds the attention feed consumed by the inbox surface; dismissal writes invalidate that cache from `inbox-dismissals.ts:5`.
- Agent conversation and queued-response handling is in `server/src/services/agent-conversations.ts` and `server/src/myrmidon/upstream-steer/queued-interaction-response.ts`.
- Heartbeat wake delivery is exposed through `server/src/services/heartbeat.ts:27988`.

## How it is intended

Inbox-lite is a compact attention layer, not a second source of truth. It should present actionable issue/agent events, let a user dismiss an item, invalidate stale feed results, and route actionable agent responses back through the durable wake/run path. Dismissal should be idempotent and scoped to the user and item identity.

## How it is implemented

`inboxDismissalService` upserts dismissals, lists them, and removes them; every mutation invalidates the attention feed cache. The feed itself is assembled by the attention service from issue and runtime state. Agent conversations can carry queued interaction responses, while heartbeat remains responsible for delivering a wake to an agent run. Thus inbox dismissal is a presentation preference, while execution remains issue- and run-backed.

## Difference from the intended design

Inbox-lite is implemented as a set of feed/cache and conversation helpers rather than one inbox aggregate. The visible item may originate in issue state, attention rules, a conversation, or a queued response. Operators must therefore trace the source event and its wake path instead of treating a dismissed row as completed work.

## Related

- [[heartbeat-runner]]
- [[task-queue]]
- [[issue-store-checkout]]
