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
  An experimental `createRecoveryWorker` provides a single quiesced recovery
  pass with retryable alerts. An experimental `createRecoverySupervisor` retries
  a supplied recovery pass and will not invoke its start callback while a pending
  issuance, failed revocation, or failed alert is reported. The experimental
  `createSupervisedSingleHostBroker` holds exclusive ownership through retries and
  the broker lifetime. `createAuditedSupervisedServer` connects that supervisor
  into TLS and closes its broker and audit store with the server. An experimental
  `createAlertSink` delivers allowlisted recovery events over mutually authenticated
  HTTPS; failures remain queued for retry, and a lost response can cause duplicates.
  This callback requires an independently operated, monitored receiver and has not
  been wired into a deployment. A successful HTTP response does not itself prove
  durable alert storage or operator notification. Audit startup failures also
  attempt an `audit_unavailable` notification, retrying with the supplied delay
  while the process remains alive. There is no local outbox at that point: an
  external supervisor must retry startup and alert on process failure; delivery
  across a crash is not guaranteed. Runtime audit failures queue `audit_unavailable`
  in the credential outbox and attempt immediate notification; delivery retries
  only after audit startup succeeds, so an independently monitored process and
  receiver remain mandatory. Outbox storage failure also needs external monitoring.
  An audit failure during issuance retains the reservation even when revocation
  succeeds, so further issuance stays fenced pending operator reconciliation.
  Broker factories also fence new issuance and owner revocation while any durable
  recovery alert remains undelivered, including an audit failure on a rejected
  request before a reservation exists. Recovery must deliver the outbox first.
  Broker factories
  hold a separate SQLite write lock across recovery and the broker lifetime; this
  is single-host cooperative exclusion only, requiring one canonical credential
  path and a filesystem with reliable SQLite locking. Direct store access and path
  aliases bypass the guard; it is not a distributed lease or deployment fence.
  A failed, interrupted, or unauditable owner revocation also keeps a durable
  reservation, blocks further issuance and queues a recovery alert. Even a bad
  handle can therefore require operator reconciliation; this favors containment
  over availability. Recovery does not automatically clear the reservation.
  It does not clear ambiguous
  reservations or provide guaranteed alert delivery. An experimental single-host
  HMAC-chained audit store is available via `createAuditedRecoveredServer`; it
  permits fixed event names only, checks integrity on startup and before each
  append, and needs a distinct server-held 32-byte key. The audited server now
  requires a CAS anchor; the supervised server supports asynchronous CAS so an
  independently operated service can be used. A lost CAS response or crash between
  CAS and the SQLite commit creates a mismatch and stops startup; reconciliation
  requires operator investigation, not an automatic reset. An experimental
  `createAnchorServer` exposes a provisioned SQLite CAS store over mTLS and pins
  the authorized client certificate. Its database must be on a separately
  administered host and storage domain; it does not prevent rollback of that
  entire domain, and no deployment wiring or operational fencing is provided.
  It has not passed security review. `createRemoteAnchor`
  supplies an mTLS client for a separately administered endpoint: GET returns a
  JSON `{seq,mac}` head with HTTP 200; POST accepts `{previous,next}` and returns
  204 only after durable linearizable CAS, or 409 on conflict. The service must
  enforce client authorization, immutable genesis and independent storage; this
  client does not implement or attest those properties. Timeouts and lost responses
  fail closed, potentially requiring manual reconciliation. `createSqliteAnchor` is a durable CAS
  reference implementation for testing separate stores, not an independently
  operated anchor service: colocating it with the audit database does not protect
  against rollback of the entire failure domain. Explicit one-time provisioning
  creates genesis; normal startup refuses a missing database, table or row. This
  does not detect rollback or replacement of the entire anchor database. A
  separately administered, independently durable and authenticated service
  with controlled provisioning is still required.
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
  The issuance reservation also remains in place if audit and token revocation
  both fail; a retained known token can be retried, but an unknown token cannot.
- Returned repository and permissions are checked against configured scope.
  A known rejected token is retained before revocation for retry after restart;
  the reservation remains ambiguous even if revocation succeeds, and requires
  operator reconciliation. If retention and revocation both fail, only the
  reservation remains. TLS helpers alone do not establish host isolation.
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
