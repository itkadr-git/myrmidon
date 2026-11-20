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

### Board service actor (read-only)

The board also exposes `GET /api/service/issues/{id}/acceptance-scenarios`
on a separate mTLS listener, not on the ordinary board listener. `{id}` is an
issue identifier or UUID. The response is the company-bound snapshot described
below, with a `null` document when no acceptance document is linked.

Configure `MYRMIDON_ACCEPTANCE_SERVICE_PORT`,
`MYRMIDON_ACCEPTANCE_SERVICE_TLS_KEY_FILE`,
`MYRMIDON_ACCEPTANCE_SERVICE_TLS_CERT_FILE`, and
`MYRMIDON_ACCEPTANCE_SERVICE_TLS_CA_FILE`. Optional
`MYRMIDON_ACCEPTANCE_SERVICE_HOST` defaults to loopback. The client must present
a CA-verified certificate and its matching service bearer; ordinary board and
agent keys are not service credentials.

A company board operator provisions a credential via
`POST /api/companies/{companyId}/acceptance-service-credentials` with JSON
fields `certificateSha256` (64 lowercase hexadecimal digits, SHA-256 of the
client certificate's DER bytes) and `expiresAt` (future ISO timestamp with
timezone). The server fixes the company and `acceptance-scenarios` audience,
stores a token hash, and returns the bearer only once; store it securely, not in
logs, command arguments, the repository, or the runner. Revoke via
`DELETE /api/companies/{companyId}/acceptance-service-credentials/{id}`.
Issuance and revocation are audited. Expired, revoked, wrong-audience, or
certificate-mismatched credentials cannot authenticate.

The 200 response carries a strong quoted `ETag` derived from the issue ID,
epoch, and revision identity. Save the exact value and send it as `If-Match`
on a later read: only an exact match succeeds; weak tags, lists and `*` are not
accepted as matches. A changed snapshot returns 412, an ambiguous snapshot 409,
and a missing or cross-company issue 404. Invalid service authentication returns
401; an untrusted client certificate can instead fail the TLS handshake.

This service is the experimental gateway's dedicated upstream. It provides a
point-in-time read, not atomic authorization at an external privileged use
boundary. Do not use it to enable privileged CI or issue privileged verdicts.

### Privileged finalization operator runbook

**Do not activate privileged finalization or GitHub verdicts before independent security review and a separate approved rollout.** This describes the implemented interface, not permission to deploy it. A GitHub side effect is not atomic with the database decision.

1. A company board operator issues a separate write credential using `POST /api/companies/{companyId}/native-finalization-service-credentials` with `certificateSha256` (lowercase SHA-256 of the client certificate DER) and future `expiresAt` (ISO timestamp with timezone). The response returns the bearer once; protect it and the private key, never log them. The write audience `native-finalization-submit` is distinct from the read-only `acceptance-scenarios` audience; neither credential substitutes for the other. Use the same verified mTLS listener described above.
2. Opt in one run using board-authenticated `POST /api/companies/{companyId}/native-finalization-grants` with UUID fields `issueId`, `runId`, `principalId`, `credentialId` and future ISO timestamp `notAfter`. The run, issue and credential must belong to the company; the coordinator must be available. The grant binds the principal, certificate and credential to that run. Issuance changes the run to service-required authorization under its coordinator lock.
3. Read the acceptance snapshot using the read credential. Submit `POST /api/service/native-runs/{runId}/finalization-requests` with the write bearer and its client certificate, the exact strong `If-Match` ETag, a printable ASCII `Idempotency-Key` (1–128 characters), and JSON `documentId`, `expectedRevisionId`, `expectedIssueEpoch` from the snapshot. A 202 receipt contains `requestId` and `statusUrl`; replay the same key and payload to retrieve the same receipt. Reusing a key with different content or submitting another active request returns 409; refresh a changed snapshot after 412.
4. GET the receipt's `statusUrl` using the same write credential and certificate. States are `accepted`, `processing`, `committed` (with `decisionId`), or `rejected` (with `errorCode`). Recovery waits for a successful workspace-finalize operation, claims a time-bounded lease and reclaims abandoned work after expiry. A stale worker cannot settle another lease. Transient errors and deadlocks remain retryable; a changed snapshot or expired/revoked authorization is rejected and its outbox consumed atomically. After snapshot rejection, read a fresh snapshot and submit a new key while the grant remains valid. A failed finalizer's separate coordinator lease may need to expire before the next request can run. A revoked or expired credential cannot query status; inspect the company-scoped records and audit as an authorized operator instead.
5. Revoke the write credential with board-authenticated `DELETE /api/companies/{companyId}/native-finalization-service-credentials/{id}`. Issuance, revocation and grant issuance are recorded as `native_finalization_service_credential.issued`, `native_finalization_service_credential.revoked` and `native_finalization_grant.issued` activity events. There is no grant-revocation API in this interface; revoke the credential to prevent further use. Inspect request/outbox state and activity without exposing bearer values.

### Gateway and upstream

- The service serves one MVCC snapshot per request:
  `GET /api/service/issues/{id}/acceptance-scenarios` returns the internal
  issue identity (`id`, `identifier`, `companyId`, `version`) and the
  `acceptance-scenarios` document (`id`, `latestRevisionId`,
  `latestRevisionNumber`, `body`) from a single joined SELECT; cross-tenant
  and missing issues are the identical 404.
- `issue.version` is a per-issue monotonic epoch in
  `issue_acceptance_epochs`, bumped by database triggers on every relevant
  mutation (issue row, acceptance link row both sides of a transfer, bound
  document, revision rows). Direct resets, row deletes and TRUNCATE fail
  closed; the epoch crosses the wire as a decimal bigint string.
- The gateway exposes only `GET /api/issues/{id}/acceptance-snapshot`. Its
  public issue projection is exactly `identifier` and `companyId`; its document
  projection is exactly `id`, `latestRevisionId`, and `body` (or null). A strong
  `ETag` can be supplied as `If-Match`; a changed snapshot returns 412.

## Operator surface

Run and provision exactly as documented in the experimental README
(configuration JSON, persistent credential records, rotation, audit file,
mTLS upstream files). `upstream.tokenFile` contains a dedicated certificate-bound
service bearer, separate from the runner-facing gateway bearer. Do not place secrets in the repository, command
arguments, logs, or the runner; do not use a regular board agent key.

## Prerequisites before any real use

- Network policy that prevents the runner from reaching the board directly.
  OPE-15287 passed a disposable HTTP network topology test: gateway reachable,
  direct core DNS failed and direct IP timed out. This is not production or mTLS proof.
- A live mTLS upstream acceptance run and negative checks with real
  credentials.
- A run-scoped single-job credential path (tracked separately; the shared
  bearer does not bind requests to one CI job).
- Independent security review.

Until all of the above are done, treat the gateway as a fixture-tested
draft and keep privileged CI disabled.
