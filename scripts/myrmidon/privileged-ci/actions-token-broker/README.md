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
  There is no recovery worker, authenticated audit sink or deployment wiring.
  The store exposes an operator-only `revokeRetained(revoke)` primitive that
  attempts to revoke every stored token, retains failures and returns only counts.
  It is not wired to a service or scheduled worker; it also revokes active tokens,
  so operators must quiesce issuance before invoking it. A successful upstream
  revoke followed by a failed database commit can require manual reconciliation.
- Issuance followed by storage and revocation failures can lose an active token;
  invalid upstream expiry can also leave a token untracked. Durable recovery
  and alerting must be implemented before any live use.
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
