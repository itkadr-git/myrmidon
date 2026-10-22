# Task queue

## Where in code

- `server/src/services/heartbeat.ts:27988` handles durable wake enqueueing and `:6903` decides whether an issue wake while a run is active becomes follow-up work.
- `server/src/services/decision-queues.ts:1` implements decision queues and their item operations.
- `server/src/myrmidon/swarm-claim/queue.ts` contains the Myrmidon swarm-claim queue helpers.
- `server/src/services/issue-dependency-wakeups.ts:6` defines the idempotent wake reason used when blockers resolve.

## How it is intended

The queue separates the request to do work from execution. It must preserve work across process/run boundaries, prevent duplicate delivery, and avoid starting a second worker for an issue with a live run. Different queue domains (agent wakeups, human decisions, swarm claims) should retain their distinct semantics while converging on heartbeat for execution.

## How it is implemented

Heartbeat stores/adopts durable wake requests and schedules run execution; the running-issue guard can convert a new wake into a follow-up rather than a parallel run. Decision queues use their own database tables and service operations for user-facing decisions. Swarm claim work has a separate queue helper. Resolved dependencies produce deterministic wake keys in `issue-dependency-wakeups.ts`, so repeated observations of the same ready state can be deduplicated.

## Difference from the intended design

There is no single general-purpose task queue abstraction. Wake requests, decision items, and swarm claims have separate persistence and consumers. This preserves domain-specific behavior but means queue ownership, retry policy, and idempotency must be checked in each subsystem instead of inferred from one shared contract.

## Related

- [[heartbeat-runner]]
- [[issue-store-checkout]]
- [[blocks-dependencies]]
- [[inbox-lite]]
