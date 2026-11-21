# Fleet owned-resource inventory

OPE-13263 supplies the persistence/reporting contract for OPE-8840 / PR #2824.
It does not enable decommission cleanup. The executor must continue to fail closed
until resource producers and safe deletion are integrated in that PR.

## Reporting contract

Authenticated executor: POST /api/myrmidon/fleet/onboard-jobs/:id/owned-resources
with the executor credential in the `x-onboard-token` HTTP header (not in
`Authorization`) and JSON `{ companyId, resource }`. The board/agent
`Authorization` credential is a separate authentication mechanism and is not
accepted as the executor credential.
Only active claimed/running onboard jobs may report. The server derives serverId
from the company-scoped job, never from caller input. Successful reports append
under a fleet-server row lock and persist in ownership_inventory JSONB. The job
is also locked and checked in the transaction. Duplicate identities are no-ops;
earlier identities cannot be overwritten by subsequent jobs. Job claims include
ownershipInventory; existing server rows and missing inventories remain null.

Resource discriminants:

- role_container: full immutable 64-hex containerId, never name/label selectors.
- ssh_key: username plus exact single authorized_keys public-key line; never
  a private key or an entire authorized_keys file.
- firewall_rule: backend ufw, exact `allow PORT/tcp|udp` rule and marker
  `myrmidon:COMPANY_UUID:SERVER_UUID`. No generic firewall command strings.

The shared parser validates version, company/server scope, fields and identities.
The executor is trusted to report only resources it actually created. A public
key/rule already present before onboarding must NOT be reported as owned merely
because it matched the desired configuration. Reports must be acknowledged
before proceeding. If creation succeeds but persistence fails, stop and reconcile;
never assume that the remaining inventory is complete.

## Integration owner: OPE-8840

Wire creation receipts into this endpoint, preserving exact identities. Validate
inventory against the claimed company/server before cleanup. A non-null inventory
is an append-only ownership log, NOT proof that onboarding completed or that every
remote side effect was recorded. Missing/corrupt inventory or an unacknowledged
creation receipt must continue to prevent cleanup. Null must never mean empty.
Deletion must inspect live identity/marker, remove only confirmed owned resources,
and preserve unrelated containers, keys and firewall rules. Do not turn the
firewall rule string or SSH public-key comment into a shell command. Do not use
UFW positional rule numbers as stable identity. Do not remove shared/pre-existing
rules, even if their port matches. This patch performs no remote deletion.

Migration 0488 adds a nullable column without backfilling ownership for existing
servers. During integration, regenerate/rebase the migration index if main gained
another migration. The snapshot is derived from 0487 with only this column added.

## OPE-13269 executor follow-up

The worker supports deliberate opt-outs for monitoring and specialized role
bootstrap. It reports `skipped`, not `ok`; an unset opt-out fails the step.

The cleanup executor validates company/server scope and requires an existing
SSH host pin before mutating remote resources. It processes exact container IDs,
marked UFW rules, and exact key lines for the login account, in that order.
It fails on command errors and does not attempt later mutations after a failure.
Deleting the final access rule or key can prevent another connection; reconcile
any ambiguous result through an independent admin channel, never by re-pinning.

This does not expose decommission via the job-start API. The current onboarding
flow does not produce complete ownership receipts for SSH keys, so existing
inventories must not be interpreted as proof that all onboarding effects are
accounted for. Production enablement requires a completeness/reconciliation
policy and a verified recovery path for the final access removal.

## Verification

Dependency-free contract tests: `node --test packages/shared/src/myrmidon-owned-resources.test.mjs`.
They cover all resource kinds, serialization, idempotent append, immutable prior
records, foreign scopes, invalid identities and null fail-closed semantics.
The existing Vitest service suite additionally covers authentication, company
isolation, server-scope derivation and refusal of completed-job reports.
The Vitest suite, typecheck and real PostgreSQL concurrency/migration checks must
run in PR CI; they were not executed locally under BUILD-OFFLOAD.

`server/src/__tests__/fleet-owned-inventory-postgres.test.ts` adds real-store
HTTP coverage for the documented header, absent/wrong/bearer-only credentials,
persisted inventory delivered by a decommission claim, concurrent distinct
appends, duplicate reports across jobs, foreign scopes, corrupt-inventory
rollback, and a terminal job transaction competing with a report. A migration
test executes the actual SQL against a temporary preexisting registry row and
asserts its inventory remains null. These are pending CI evidence, not a claim
that PostgreSQL concurrency or route behavior has already passed verification.
