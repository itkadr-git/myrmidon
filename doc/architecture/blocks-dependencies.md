# Blocks and dependencies

## Where in code

- `server/src/services/issues.ts:1913` accepts `blockedByIssueIds`; dependency readiness and blocked-dependent lookup are implemented in the issue service, including `getDependencyReadiness` and `listWakeableBlockedDependents`.
- `server/src/services/issue-dependency-wakeups.ts:6` defines `ISSUE_BLOCKERS_RESOLVED_WAKE_REASON` and idempotency/state-key builders (`:84`, `:100`, `:121`).
- `server/src/services/heartbeat.ts` consumes wake requests and protects active issue runs from parallel execution.
- The database relationship is managed by issue-service operations and exposed as issue relations, not by the wakeup helper itself.

## How it is intended

A blocked issue records explicit blocker relationships and remains ineligible until all required blockers reach a resolved state. When readiness changes, the dependent should be woken once for that newly ready state. Repeated resolution notifications must not create duplicate runs, and dependency bookkeeping must remain separate from the issue's execution lock.

## How it is implemented

Issue service computes dependency readiness and returns eligible dependent issues. The wake helper derives a deterministic key from blocker/dependent readiness state and searches for an existing delivered or in-flight wake before creating another one. Heartbeat then handles execution and checkout ownership. This separates relationship evaluation, wake deduplication, and run execution into distinct layers.

## Difference from the intended design

Dependency readiness is computed from issue state at service level, while the wakeup service handles deduplication separately; there is no single atomic dependency-queue primitive spanning both. The implementation must re-check readiness and active-run state during wake handling, particularly when dependencies change close together.

## Related

- [[issue-store-checkout]]
- [[task-queue]]
- [[heartbeat-runner]]
