# Acceptance reader (experimental)

This standalone gateway is not a production deployment. It exposes only the two
company-bound GET projections in `reader.mjs`. The upstream must implement the
atomic snapshot endpoint `GET /api/issues/{id}/acceptance-scenarios-snapshot`
(OPE-15134), which returns one JSON object:

```json
{
  "issue": { "id": "…", "identifier": "OPE-123", "companyId": "…" },
  "document": { "id": "…", "latestRevisionId": "…", "latestRevisionNumber": 7, "body": "…" }
}
```

`document` is `null` when the issue has no `acceptance-scenarios` document.
The upstream reads the issue row and the document graph with a single SQL
statement, so both always come from one database snapshot; the gateway issues
exactly one upstream read per runner request and never stitches independent
reads into an answer. Upstream not-found is the identical `404` for foreign
and unknown issues (no existence oracle); network failures, `5xx`, oversized
or invalid payloads are a bare `502` that never carries a partial body. This
contract has only been exercised against a fixture, not a live Myrmidon
service.

## Result integrity contract (supported)

The document carries a monotonic write generation. Every accepted document
write mints a new revision row, moves `latest_revision_id` to it and
increments `latest_revision_number`; revision ids and numbers are never
reused, and reverting the content (A→B→A) mints a new revision and therefore
a new generation. As a result, equality of the pin tuple

    (issue.id, issue.identifier, issue.companyId,
     document.id, document.latestRevisionId, document.latestRevisionNumber)

across two fresh reads proves that no write to any of these occurred between
the reads — including content reverts.

A gate that wants a verified result MUST follow this pattern:

1. **Pin.** Read the snapshot fresh; remember the pin tuple. If the document
   is absent there is nothing to verify — fail the run for this issue.
2. **Verify.** Immediately before producing the result, read the snapshot
   fresh again and require the identical pin tuple. Any difference means a
   write occurred: fail closed and do not publish.
3. **Publish.** Name the verified pin tuple in the published evidence.
4. **Use.** Anyone consuming the result re-reads the snapshot and requires
   the identical pin tuple before relying on it.

Step 2 is what excludes a late invalidation before the result, and step 4 is
the atomic check at the use boundary: a verdict is only as current as the
last read, and the tuple in the evidence lets a consumer detect staleness.

This contract is read-only and honest about its boundary: it cannot detect a
write that lands after the final read — publication must immediately follow
the verifying read, and consumers must re-validate at use. It also does not
bind the two reads to one CI job: with the current operator-issued shared
bearer, run binding is the caller's discipline. A run-scoped single-job
credential remains an operational prerequisite (tracked on the board under
OPE-15135/OPE-15148); until it exists, privileged CI must not be enabled on
the basis of this contract, and concurrent runners sharing a bearer are not
isolated from each other.

## Operation / Запуск

Run `node scripts/myrmidon/privileged-ci/acceptance-reader/main.mjs /private/config.json`
as a dedicated unprivileged service account. Configuration is operator-owned JSON:

```json
{
  "host": "127.0.0.1", "port": 8443,
  "credentialDirectory": "/private/reader-credentials",
  "auditFile": "/private/reader-audit.jsonl",
  "listener": { "cert": "/private/listener.crt", "key": "/private/listener.key" },
  "upstream": { "origin": "https://upstream.example:8443", "ca": "/private/upstream-ca.crt", "cert": "/private/client.crt", "key": "/private/client.key" }
}
```

The account must be able to append to the audit file and access its private
credential directory and TLS files. Restrict their ownership and permissions;
never place secrets in the repository, command arguments, logs, or runner.
Provision credential records through `createPersistentCredentialStore.issue`
with a SHA-256 hex digest of a high-entropy bearer, immutable companyId, and
expiry in Unix milliseconds. `revoke(hash)` writes a persistent revocation marker.
Do not delete or rewrite records/markers; protect the directory from other writers.
All gateway instances need the same durable, coherently shared directory. Revocation
is checked before serving responses; storage errors deny access.
Rotate by issuing a new token and revoking the old one. Do not use a regular
board agent key.

Настройка и ключи принадлежат оператору; runner получает только отдельный
bearer gateway. Запись содержит SHA-256 токена, неизменяемый companyId и срок
действия в миллисекундах; отзыв сохраняется отдельным маркером. Запрещено менять
записи или давать runner доступ к каталогу, ключам TLS и upstream. Fixture не
является проверкой production. Реальная сетевая изоляция требует отдельного
подтверждения инфраструктуры до развёртывания.

## Threat model and limitations

A malicious runner can choose methods, paths, headers and payloads and holds only
its gateway bearer. The gateway checks the fixed credential company against the
snapshot issue before returning minimal fields, rejects unlisted routes/methods,
uses fixed-origin TLS with a client certificate, and rechecks credentials before
response. Audit records contain only response status. TLS keys, credential store,
config, audit and upstream are trusted operator assets; an operator or upstream
compromise is outside this boundary. A shared filesystem must have coherent
visibility for revocations.

TLS alone does not establish network isolation: a runner must be prevented by
network policy from reaching upstream directly. No such policy or live upstream
integration has been demonstrated here. Do not deploy until these are verified,
and until an independent security review and actual-credential negative checks
are completed. No production credential has been issued by this component.

## Verification

`devbuild 'node --test scripts/myrmidon/privileged-ci/acceptance-reader/*.test.mjs'`
uses a separate local TLS fixture with synthetic credentials. It is not a GitHub
OIDC exchange, a production test, or proof of network isolation. The fixture
includes an executable ABA regression: three sequential reads across the
mutations r1→r2→r1 expose three distinct pin tuples, which is exactly what the
pin/verify contract above detects and a bare revision-id comparison would miss.
