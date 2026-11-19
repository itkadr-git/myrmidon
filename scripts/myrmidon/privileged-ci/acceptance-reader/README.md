# Acceptance reader (experimental)

This standalone gateway is not a production deployment. It exposes exactly two
runner-facing operations for one company-bound acceptance snapshot. The
upstream must implement `GET /api/issues/{id}/acceptance-scenarios-snapshot`
(OPE-15134) returning one JSON object:

```json
{
  "issue": { "id": "…", "identifier": "OPE-123", "companyId": "…", "version": "7" },
  "document": { "id": "…", "latestRevisionId": "…", "latestRevisionNumber": 7, "body": "…" }
}
```

`document` is `null` when the issue has no `acceptance-scenarios` document.
The upstream reads the issue row and the whole tenant-bound document graph
with a single SQL statement, so the response always comes from one MVCC
snapshot; the gateway issues exactly one upstream read per runner request.
Upstream not-found is the identical `404` for foreign and unknown issues (no
existence oracle); network failures, `5xx`, oversized or invalid payloads are
a bare `502` that never carries a partial body. This contract has only been
exercised against a fixture, not a live Myrmidon service.

## Pin and verify

`GET /api/issues/{ref}/acceptance-snapshot` returns the minimal projection of
that single snapshot — the full pin:

```json
{
  "issue": { "id": "…", "identifier": "OPE-123", "companyId": "…", "version": "7" },
  "document": { "id": "…", "latestRevisionId": "…", "latestRevisionNumber": 7, "body": "…" }
}
```

`issue.version` is a per-issue monotonic epoch kept in its own
`issue_acceptance_epochs` table (migration 0489) and bumped by database
triggers on any insert/update of the issue row (company, identifier,
anything), on insert/update/delete of the issue's `acceptance-scenarios`
link row (both the old and the new issue on a transfer), and on
insert/update/delete of the bound document and its revision rows. It covers
every writer, including batch imports, future code and direct SQL, and it
survives delete+recreate: the epoch row has no foreign key to issues, a
BEFORE UPDATE trigger rejects any attempt to wind it back, and an AFTER
DELETE trigger restores a deleted row at epoch+1, so no writer can reset the
generation and make a stale pin compare equal. Because a bump is a single-row
upsert on the epochs table — never a guarded write back into the issues
table — triggers nested anywhere in a bump chain run normally. The counter
is a decimal string, exact beyond 2^53 where JavaScript numbers collapse
adjacent generations.

`POST /api/issues/{ref}/acceptance-snapshot/verify` takes a previously pinned
snapshot as its JSON body and performs the conditional assertion server-side.
The gateway reads and validates the bounded request body **first**, then
reads the fresh snapshot, then compares the whole pin — a slow client cannot
pin the comparison to a moment older than its own evidence. The response is
`200 { "ok": true }` when no relevant mutation committed between the pin and
this verify, `409` when anything moved, `400` for a malformed pin, `401` on
expiry/revocation, and `502` on upstream failures. A tenant move makes the
fresh read foreign, so every request fails closed with the identical `404`.
The pin schema is strict: a missing `document` property is a corrupted
payload, never silently "no document".

## Result semantics (read this before trusting a result)

A verify proves the pinned snapshot still equals the current state **as of
that verify** — nothing more. Check and use are separate operations, and no
read-only gateway can see a write that lands after its last read. The
supported pattern is:

1. Pin with `GET`; remember the whole response.
2. Immediately before producing or consuming a result, `POST /verify` with
   the pin. On `409`/`401`/`502` fail closed.
3. Publish the verified pin as the result's evidence.
4. Use the result immediately after the verify. Any later reliance — a new
   step, a re-run, a consumer — performs its own `POST /verify` first; the
   evidence pin makes staleness detectable at any point.

There is deliberately no "atomic at use" claim: an atomic commit of the
verification with the publication of a CI verdict lives in the gate layer,
which is out of scope for this gateway. What this gateway guarantees is
exact: one MVCC snapshot per response, tenant confinement checked before any
output, and a server-side conditional assertion that detects every relevant
mutation up to the moment of the verify.

This contract also does not bind requests to one CI job: with the current
operator-issued shared bearer, run binding is the caller's discipline. A
run-scoped single-job credential remains an operational prerequisite (tracked
on the board under OPE-15135/OPE-15148); until it exists, privileged CI must
not be enabled on the basis of this contract, and concurrent runners sharing
a bearer are not isolated from each other.

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
executes the full production path — pin, verify, content/link/company/identifier
ABA (each detected), mutation after verify (detected at the next verify) — plus
the tenant, credential-lifecycle and failure-class regressions.
