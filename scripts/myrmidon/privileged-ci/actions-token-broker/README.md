# Actions installation-token broker (experimental, not deployable)

This directory is an unfinished security-sensitive prototype. Do not deploy it,
connect it to production credentials, or treat fixture tests as a GitHub exchange.
It has not passed independent security review or live acceptance.

## Threat model

An attacker may control a workflow caller, event inputs, a fork or pull request,
request bodies, JWT headers and claims, or a leaked credential handle. The
broker must not trust any of these as authorization. Only a signed GitHub Actions
identity matching a server-owned, immutable repository and owner policy, trusted
caller and reusable workflow, ref, environment, event and actor may be accepted.
Handles must be bound to the immutable run identity, not treated as authority.
Compromise of the broker host, its signing key or its trusted configuration is
outside this component's protection and must be mitigated by isolated deployment,
secret management, least privilege and key rotation.

## Current gaps / remaining gates

- The single-host broker factory wires replay protection to a persistent SQLite
  database. All broker processes must share that local database on a supported
  filesystem; this does not support separate hosts. The factory wires an
  experimental AES-GCM SQLite credential store when a credential path and key
  are provided. Its single-host locking and key custody need independent review.
  There is no recovery worker or deployment wiring. An experimental single-host
  HMAC-chained audit store is available via `createAuditedRecoveredServer`; it
  permits fixed event names only, checks integrity on startup and before each
  append, and needs a distinct server-held 32-byte key. The audited server now
  requires a synchronous CAS anchor, but no independently durable anchor service
  or deployment wiring is provided. An in-memory or colocated anchor is not
  adequate: it cannot protect against rollback of the entire failure domain.
  Host compromise, availability, alerting and remote collection remain
  unaddressed. Do not treat it as a production audit system.
  The experimental `createRecoveredSingleHostBroker` revokes stored tokens before
  returning a broker and refuses startup when any revoke fails. It is not a
  deployed service, distributed lock, or scheduled worker; operators must stop
  every issuer sharing the store before recovery because it also revokes active
  tokens. A successful upstream revoke followed by a failed database commit can
  require manual reconciliation.
- Issuance followed by storage and revocation failures can lose an active token;
  invalid upstream expiry can also leave a token untracked. A process crash or
  lost HTTP response after GitHub creates a token can leave the token unknown to
  this service even if local storage is healthy. GitHub issuance and a local
  database commit are not one atomic transaction. A pending local record alone
  cannot recover a token whose value was never received. The design needs an
  approved containment and reconciliation strategy for ambiguous issuance, as
  well as durable recovery and alerting, before any live use. Do not assume an
  unknown token can be individually revoked; GitHub's expiry is the remaining
  boundary unless an independently verified revocation mechanism is available.
- Returned repository and permissions are checked against configured scope,
  but revocation failure after a rejected response still needs durable recovery.
  TLS helpers alone do not establish host isolation.
- The prototype permits only `contents: read`; this is a restrictive test
  profile, not an approved workflow policy or evidence that this permission is
  sufficient for the eventual integration. Any expansion requires review.
- Independent security review must be repeated on the final head. Live acceptance
  requires an authorized isolated test App, installation policy and genuine
  Actions OIDC; fixtures are not evidence of GitHub compatibility.
- GitHub installation tokens normally expire after one hour. Revocation requires
  a successful GitHub API call; neither local expiry bookkeeping nor a failed
  revoke invalidates a token already issued by GitHub.

## Verification / Проверка

Run from the task checkout:

    devbuild 'node --test scripts/myrmidon/privileged-ci/actions-token-broker/*.test.mjs'

These tests use generated cryptographic fixtures and mocked upstream calls. They
exercise local behavior only, not a live GitHub exchange.

Тесты используют криптографические фикстуры и подменённый GitHub API; они не
подтверждают реальный обмен. Компонент незавершён: не разворачивать и не
подключать к production. Для приёмки нужны защищённый тестовый стенд, реальный
Actions OIDC, проверка отзыва и отдельное повторное security review.
