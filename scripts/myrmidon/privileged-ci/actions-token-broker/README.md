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

- The supervised audited TLS path requires a separate replay key and independent
  replay anchor and verifies the anchored replay log before serving. A rollback,
  suffix deletion, unavailable anchor or interrupted anchor commit fails closed.
  If the replay anchor commits but its acknowledgement is lost, the local replay
  transaction rolls back; the resulting mismatch also prevents restart. This is
  containment, not automatic reconciliation or proof of an independent deployment.
  The unanchored single-host and synchronous helpers remain vulnerable to replay
  database rollback and must not be used for live service. The append-only replay
  log has no bounded retention, and the anchor needs a separately administered
  failure domain and further security review. Replay startup failures attempt a
  best-effort `replay_unavailable` alert; failed delivery is not durable, so an
  independent process monitor must detect and retry startup failures. Runtime replay
  store failures latch the broker closed, queue `replay_unavailable` and attempt
  immediate delivery; storage or delivery failure still needs independent monitoring.
  Recovery retries the outbox, but operators must investigate the cause before restart.
  The factory wires an
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
 attempt an `audit_unavailable` notification before known-token recovery can
 enter its retry loop, retrying failed delivery with the supplied delay
 after recovery while the process remains alive. There is no local outbox at that point: an
  external supervisor must retry startup and alert on process failure; delivery
  across a crash is not guaranteed. Runtime audit failures queue `audit_unavailable`
  in the credential outbox and attempt immediate notification; delivery retries
  only after audit startup succeeds, so an independently monitored process and
  receiver remain mandatory. Outbox storage failure also needs external monitoring;
  a supervisor failure now attempts an independent immediate recovery-failure alert
  before exiting, but this is best effort and cannot guarantee delivery across crash.
  An audit failure during issuance retains the reservation even when revocation
  succeeds, so further issuance stays fenced pending operator reconciliation.
  If finalization reports failure after deleting its reservation, the broker tries
  to recreate the fence before revocation and latches the running process closed.
  A crash or storage failure before that recreation can still leave no durable
  reservation. An unsupervised broker reopening a store with retained credentials
  now refuses new issuance until restarted through recovery; owner revocation stays
  available. This is not sufficient if no credential was retained, or if audit and
  outbox writes both fail without a reservation: external supervision and
  investigation remain required before restart.
  An ambiguous issuance also latches the running broker closed even if its
  reservation and alert outbox are lost. This latch is process-local, not a
  substitute for independent durable containment across restart. The supervised
  audited TLS path now also anchors an issuance intent before contacting GitHub;
  an unresolved intent prevents audit startup after restart, including when the
  credential reservation is lost. This deliberately sacrifices availability:
  there is not yet a reviewed operator reconciliation procedure to clear it.
  The unsupervised and synchronous audited helpers do not provide this protection.
  On a verified anchored pending intent, supervised TLS startup recovers under
  the credential-store lock, retrying known-token revocation and alert delivery
  with the configured delay, but still refuses to start. Audit startup failures,
  including an anchor mismatch or unavailable anchor, also attempt known-token
  recovery under that lock without clearing or trusting the failed audit state.
  Recovery retries known-token revocation even if the alert outbox fails; it
  attempts direct notification but still reports an alert failure and remains
  closed. The normal recovery supervisor also keeps retrying known-token revocation when
  outbox writes or reads fail, without starting issuance; it retries unqueued alerts in
  memory and attempts direct delivery. A reservation read failure in the recovery
  worker also remains fenced and retries known-token revocation; its direct failure
  alert is best effort. A crash can still lose those in-memory
  alerts, so external monitoring is required. Direct notification is best effort,
  not a durable replacement.
  An interrupted pass needs an external restart/supervisor to retry; an unknown
  token cannot be recovered. Missing or rolled-back local credentials remain
  unknown and require independent operator containment.
  Broker factories also fence new issuance and owner revocation while any durable
  recovery alert remains undelivered, including an audit failure on a rejected
  request before a reservation exists. Recovery must deliver the outbox first.
  If audit and outbox writes both fail, a process-local latch blocks later issuance
  until restart. An issuance checks the latch before and after its audit append
  and again after reservation finalization, revoking a known token if a concurrent
  failure is observed; this does not fence every possible race or across processes.
  An independent supervisor must stop service and investigate storage
  failure before restart; do not rely on it for cross-process containment.
  Broker factories
  hold a separate SQLite write lock across recovery and the broker lifetime; this
  is single-host cooperative exclusion only, requiring one canonical credential
  path and a filesystem with reliable SQLite locking. Broker close now refuses
  while requests are in flight, preserving the lock until they settle; closed
  broker instances reject new requests. Direct store access and path aliases
  bypass the guard; it is not a distributed lease or deployment fence.
  A failed, interrupted, or unauditable owner revocation also keeps a durable
  reservation, blocks further issuance and queues a recovery alert. The supervised
  audited path also anchors the revocation intent before contacting GitHub, so
  losing the local reservation cannot silently permit startup after a failed or
  interrupted revocation. Even a bad handle can therefore require operator
  reconciliation; this favors containment over availability. Recovery does not
  automatically clear the reservation or the anchored intent.
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
- A valid response is now persisted as soon as it is parsed and validated, before
  the installation client returns it to the broker. A failed persistence attempts
  immediate revocation and leaves the pre-existing reservation ambiguous; it does
  not close the crash window between GitHub issuance and parsing/persistence.
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

## Incident containment and reconciliation (draft; not authorization to deploy)

The intent and alert fences are deliberately not self-clearing. A restart loop
is not a reconciliation procedure. Until an independent security review approves
one, keep issuance disabled and do not delete, reset, provision over, or manually
edit either database or the anchor head. In particular, do not infer that an
unknown token was revoked because a known-token recovery pass succeeded.

For a test incident, the designated operator should:

1. Stop and fence every issuer, including automated restarts, before touching the
   stores. Preserve the issuer store, audit database including WAL/SHM, independent
   anchor state, outbox, and relevant service logs as restricted evidence. Do not
   paste tokens, JWTs, keys, encrypted credential records, or request bodies into
   tickets or logs. Coordinate snapshots with the respective store owners so that
   each is consistent; a copied live SQLite main file alone is not a backup.
2. Notify the security reviewer and the separately operated anchor and alert
   service owners. Confirm independently that alerts were durably received and
   delivered to an operator; an HTTP success alone does not establish that fact.
   An unavailable alert path, missing evidence, or a mismatched anchor is itself an
   incident and must not be suppressed by reinitialization.
3. With issuance still fenced, retry known-token revocation through the existing
   locked recovery path. Preserve failures for retry. A lost response, missing or
   rolled-back credential record, or failed persistence can leave a token unknown:
   the recovery path cannot individually revoke it. Document the affected test
   installation and incident time without copying credentials. Do not use the
   production App or ordinary self-hosted runners for investigation.
4. Security and the test-App owner must establish and document an independently
   verified containment boundary for every possibly issued token, including an
   evidence-based latest possible expiry and clock uncertainty, or another GitHub
   mechanism whose scope and effect they have actually verified. GitHub's normal
   one-hour lifetime is not proof of a specific unknown token's expiry time.
   If the last possible issuance time or effective containment cannot be proven,
   keep the service fenced and escalate; waiting an arbitrary hour is insufficient.
5. Compare the preserved audit chain and the independently administered anchor;
   distinguish a pending intent from a lost CAS response, rollback, deletion,
   unavailable service, or tampering. Do not advance or roll back the anchor to
   force a match. Record evidence and obtain an independently reviewed recovery
   decision before any change to state. The prototype provides no supported
   procedure or command to clear an unresolved anchored intent; reconstructing or
   replacing state remains out of scope until such a procedure is reviewed and
   tested. Keep the service disabled rather than inventing one.

The anchor must be provisioned and operated in a separate administrative and
storage failure domain with monitored availability, controlled access and backups;
using two SQLite files on the same host is not independent protection. A complete
rollback of the anchor domain is not detected by this prototype. The alert receiver
and process watchdog must also be independently operated and monitored. These are
requirements, not deployed infrastructure or evidence of live acceptance.

## Verification / Проверка

Run from the task checkout:

    devbuild 'node --test scripts/myrmidon/privileged-ci/actions-token-broker/*.test.mjs'

These tests use generated cryptographic fixtures and mocked upstream calls. They
exercise local behavior only, not a live GitHub exchange.

Тесты используют криптографические фикстуры и подменённый GitHub API; они не
подтверждают реальный обмен. Компонент незавершён: не разворачивать и не
подключать к production. Для приёмки нужны защищённый тестовый стенд, реальный
Actions OIDC, проверка отзыва и отдельное повторное security review.
