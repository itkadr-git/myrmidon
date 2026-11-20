# Acceptance reader

> Russian version: [acceptance-reader.ru.md](acceptance-reader.ru.md)

A narrowly scoped, company-bound gateway between an untrusted CI runner and
the Myrmidon board, built for acceptance-scenario verification. Code:
`scripts/myrmidon/privileged-ci/acceptance-reader/`; upstream read model:
`server/src/services/issue-acceptance-snapshot.ts` and
`server/src/routes/issue-acceptance-snapshot.ts`; migrations:
`packages/db/src/migrations/0489_complete_aqueduct.sql` (epoch triggers).

## Status

Experimental draft. Not deployable, no production credential has been issued,
and privileged CI must not be enabled on this component until every
prerequisite below is satisfied. The authoritative component contract,
threat model and fixture verification live in the experimental
[acceptance-reader README](../../scripts/myrmidon/privileged-ci/acceptance-reader/README.md).

## What it does

- The board serves one MVCC snapshot per request:
  `GET /api/issues/{id}/acceptance-scenarios-snapshot` returns the minimal
  issue identity (`id`, `identifier`, `companyId`, `version`) and the
  `acceptance-scenarios` document (`id`, `latestRevisionId`,
  `latestRevisionNumber`, `body`) from a single joined SELECT; cross-tenant
  and missing issues are the identical 404.
- `issue.version` is a per-issue monotonic epoch in
  `issue_acceptance_epochs`, bumped by database triggers on every relevant
  mutation (issue row, acceptance link row both sides of a transfer, bound
  document, revision rows). Direct resets, row deletes and TRUNCATE fail
  closed; the epoch crosses the wire as a decimal bigint string.
- The gateway exposes one pin route and one server-side conditional verify.
  Verify validates the bounded request body before a fresh upstream read and
  answers 200/409/400/401/502.

## Operator surface

Run and provision exactly as documented in the experimental README
(configuration JSON, persistent credential records, rotation, audit file,
mTLS upstream files). Do not place secrets in the repository, command
arguments, logs, or the runner; do not use a regular board agent key.

## Prerequisites before any real use

- Network policy that prevents the runner from reaching the board directly.
- A live mTLS upstream acceptance run and negative checks with real
  credentials.
- A run-scoped single-job credential path (tracked separately; the shared
  bearer does not bind requests to one CI job).
- Independent security review.

Until all of the above are done, treat the gateway as a fixture-tested
draft and keep privileged CI disabled.
