# Wake and heartbeat payload

## Where in code

- `server/src/services/heartbeat.ts:7701` defines `buildPaperclipWakePayload`, assembling structured wake context, comments, attachments, and stage metadata.
- `server/src/services/heartbeat.ts:28408` implements `enqueueWakeup` and `:28426` implements `enqueueWakeupInner` for durable wake admission.
- `server/src/services/heartbeat.ts:25420` and `:26221` project `wakePayloadForDispatch` before invoking runner adapters.
- `server/src/services/heartbeat-policy.ts:4` evaluates agent runtime config (`isHeartbeatWakeOnDemandEnabled`) across on-demand, assignment, and automation triggers.
- `server/src/services/run-continuation-snapshot.ts:40` implements `wakePayloadForDispatch` to reattach continuation data without duplicate database persistence.
- `server/src/myrmidon/wake-task-guard.ts:38` checks `isTasklessAutomaticWake`, `:52` calculates `tasklessGateReason`, and `:401` lists cooling issues (`listCoolingIssues`).
- `server/src/myrmidon/wake-task-guard-routes.ts:16` mounts `myrmidonWakeTaskGuardRoutes` exposing GET `/myrmidon/companies/:companyId/swarm/cooling` (`:19`).

## How it is intended

The wake and heartbeat payload subsystem forms the contract between the control plane scheduler and executing agent runs. Wake requests signal that an issue or agent requires attention (assignment, new comments, dependency resolution, timer, or human interaction). The scheduler must admit wakes idempotently, deduplicate concurrent requests for the same issue, verify task presence for automatic wakes, and enforce cooling intervals for repeatedly failing or idle tasks. When a run starts, the heartbeat constructs a structured, size-capped wake payload containing the issue summary, recent unread comments, attachments, execution stage, and continuation context so the agent can resume work immediately without redundant fetches.

## How it is implemented

`enqueueWakeup` persists durable wake rows in `agentWakeupRequests`, checking runtime policies in `heartbeat-policy.ts`. Before admission, automatic wakes pass through `wake-task-guard.ts`: taskless automatic wakes are gated immediately (`tasklessGateReason`), and stale runs without task progress enter an exponential cooling period evaluated by `decideIssueCooling`. During run dispatch, `buildPaperclipWakePayload` queries the database to assemble the wake object, truncating comment bodies and attachment lists to fit safe budget caps (`MAX_INLINE_WAKE_*`). To prevent snapshot bloat, `run-continuation-snapshot.ts` stores the large execution continuation envelope separately in `heartbeat_run_continuations`, and `wakePayloadForDispatch` attaches it in memory only when delivering the payload to the agent adapter or runner process.

## Difference from the intended design

The wake payload is constructed on demand from several tables (issues, issue comments, attachments, interaction records, run continuations) rather than being persisted as a pre-computed event payload. Because database snapshots and delivery payloads have different size constraints, continuation data is decoupled in storage and rejoined at dispatch time. Additionally, task cooling and taskless wake guards were layered on top of the original Paperclip heartbeat as Myrmidon-specific guard filters rather than a native queue-level rate limiter.

## Related

- [[heartbeat-runner]]
- [[task-queue]]
- [[blocks-dependencies]]
- [[issue-store-checkout]]
