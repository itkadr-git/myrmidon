# Heartbeat and runner

## Where in code

- `server/src/services/heartbeat.ts:9445` creates `heartbeatService`.
- The service's wake path is `enqueueWakeup` at `server/src/services/heartbeat.ts:27988`; follow-up wake decisions include `shouldQueueFollowupForRunningIssueWake` at `:6903`.
- Run/issue lock cleanup is coordinated in the same service at `:16174` and `:17972`.
- Supporting invariants live in `server/src/myrmidon/heartbeat-idle-skip.ts` and `server/src/myrmidon/issue-checkout-guard.ts`.

## How it is intended

Heartbeat is the durable runner loop: admit a wake, choose work, start or resume one run, and deliver the result without duplicating a live turn. A wake should be idempotent and stale work should not reclaim an issue owned by another live run. Idle pickup and follow-up work must respect the issue's dependency and checkout state.

## How it is implemented

`heartbeatService` owns wake admission and the run lifecycle. `enqueueWakeup` records a durable wake request, while the running-issue follow-up guard prevents an ordinary wake from spawning a competing turn. During cleanup, heartbeat nulls checkout ownership only when the issue points at the run being finalized; the issue lock predicates also allow the current run to retain its own lock. Idle-skip policy and checkout guards provide Myrmidon-specific gates around the generic runner.

## Difference from the intended design

The runner is a broad orchestration service rather than a small scheduler: wake admission, retries, workspace preparation, run cleanup, and delivery are co-located. The intended state machine is therefore observable through several code paths and database fields, not one queue class. The implementation additionally contains compatibility/retry paths for interrupted or queued interactions.

## Related

- [[issue-store-checkout]]
- [[task-queue]]
- [[inbox-lite]]
