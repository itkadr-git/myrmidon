# Issue store and checkout

## Where in code

- `server/src/services/issues.ts:6411` defines `issueService`; the issue row projection includes `checkoutRunId` at `:4816`.
- `server/src/services/issues.ts:11347` implements `checkout`; the transaction updates assignment, execution, and checkout ownership.
- `server/src/myrmidon/issue-checkout-guard.ts:29` validates task-source context, and `:62` reads the heartbeat run status for an issue.
- `server/src/myrmidon/issue-write-run-lock.ts:80` and `:108` resolve live write locks for issue mutations.

## How it is intended

The issue store is the durable state machine for work. A checkout must be exclusive, tied to the active heartbeat run, and safe under retries. A run may continue its own checkout, while a different live run must not overwrite the lock. Terminal or stale runs must release the lock before another worker can proceed.

## How it is implemented

`issueService.checkout` performs the ownership checks and writes `checkoutRunId` together with the execution lock. It distinguishes the actor run from a competing run and returns the current lock when the expected owner does not match. Issue updates clear checkout state on terminal transitions (`server/src/services/issues.ts:10837-10848`), while stale-lock cleanup verifies the referenced heartbeat run under a row lock before clearing it (`:7532-7584`). The guard and write-lock modules keep route-level mutations from claiming an issue without a valid run context.

## Difference from the intended design

The intended invariant is distributed across the large issue service, the heartbeat service, and small guard modules rather than enforced by one store abstraction. The implementation therefore has explicit compatibility paths for stale and same-run locks. Readers should follow both the issue row and the heartbeat run when diagnosing ownership.

## Related

- [[heartbeat-runner]]
- [[task-queue]]
- [[blocks-dependencies]]
