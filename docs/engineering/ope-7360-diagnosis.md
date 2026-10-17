# OPE-7360 bulk summaries HTTP 500 diagnosis

## State

This is a diagnostic handoff, not a fix. The intermittent HTTP 500 has not been
reproduced in this checkout, and no root cause is established.

## Current code evidence

`server/src/__tests__/external-object-routes.test.ts` already includes
`allows board users to fetch company-scoped external object summaries in bulk`.
It creates an Express app with the real `issueRoutes` and `errorHandler`, posts
one issue ID as a board actor, and asserts HTTP 200, summary contents, and the
service call. Its setup uses `vi.resetModules()`, registers route mocks, and
loads the route and middleware with `vi.importActual()` in `Promise.all`.

The known CI observation is intermittent: two tag-CI attempts returned 500 for
this bulk board case while the other eight tests passed; reruns were green.
Previously reported individual-file local runs passed 9/9, but the full
serialized shard was not verified. These observations do not identify whether
the failure is in test module state, import ordering, or production behavior.

## Safe next diagnostic

Reproduce the serialized shard 3/5 with complete output and exit status. If it
fails, add test-only error capture before `errorHandler` to expose only the
fixture-safe error message/stack, avoiding raw production logging. Compare the
failing and passing run's module/mock setup before changing production code.
Then add a regression test that fails for the established cause, implement the
smallest fix, and run five consecutive full serialized shard 3/5 executions on
the same commit SHA. Confirm the intended release line before porting.

## Not done

No code change, test run, root-cause proof, fix, gitleaks run, independent
review, or release validation is included in this diagnostic handoff.