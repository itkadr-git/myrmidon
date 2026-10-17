# Remote-site health reducer

`health-reducer.ts` is a pure, deterministic transition function. T4 integration supplies the previous snapshot, the current timestamp (`now`, epoch milliseconds), a health result, and the resource-degradation flag. Persist the returned `state`, `lastSeenAt`, `missCount`, `unavailableSince`, `manualDrain`, and `pinnedBotCount`; dispatch returned intents idempotently, keyed by site and intent type/outage episode. A `success` clears only network misses/outage timing; manual drain and quarantine require an explicit operator action to clear.

The caller owns polling at `SITE_HEALTH_POLL_INTERVAL_MS` (30 seconds) and enforcing `SITE_HEALTH_TIMEOUT_MS` (5 seconds); this module performs neither network I/O nor persistence. The third consecutive timeout emits `drain`; continuous outage emits `failover` at ten minutes or later, unless pinned bots exist. Quarantine is emitted for invalid certificates and incompatible protocol. Resource degradation reports `degraded` without an automatic drain. Intents are declarations only: T4 owns execution, including any move/failover; this reducer never changes leases/runs or creates move/requeue candidates.

The focused test file uses explicit timestamps, no wall-clock waits or network: `health-reducer.test.ts`.
