# Acceptance reader (experimental)

Operator documentation (EN/RU): [docs/myrmidon/acceptance-reader.md](../../../../docs/myrmidon/acceptance-reader.md)
and [acceptance-reader.ru.md](../../../../docs/myrmidon/acceptance-reader.ru.md).

This standalone gateway is not a production deployment. It exposes exactly one read-only
runner-facing operation for one company-bound acceptance snapshot. The
upstream is the dedicated service listener's `GET /api/service/issues/{id}/acceptance-scenarios`
(OPE-15134), authenticated with a certificate-bound service bearer, returning one JSON object:

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
a bare `502` that never carries a partial body. The real-core integration test
below exercises this contract against a PostgreSQL-backed core using synthetic
credentials; it is not a production test.

## Conditional snapshot reads

Security limitation: the database writer protocol has targeted PostgreSQL
regression coverage, but it and the consumer's check-and-use transaction still
require independent review. Do not enable privileged CI on this basis.

`GET /api/issues/{ref}/acceptance-snapshot` returns the minimal projection of
that single snapshot:

```json
{
  "issue": { "identifier": "OPE-123", "companyId": "…" },
  "document": { "id": "…", "latestRevisionId": "…", "body": "…" }
}
```

`issue.version` is a per-issue monotonic epoch kept in its own
`issue_acceptance_epochs` table (migration 0489) and bumped by database
triggers on any insert/update of the issue row (company, identifier,
anything), on insert/update/delete of the issue's `acceptance-scenarios`
link row (both the old and the new issue on a transfer), and on
insert/update/delete of the bound document and its revision rows. Acceptance
links set a company-bound owner on the document in the same transaction;
revision writers update that document row before writing. A stale REPEATABLE
READ writer therefore encounters a serialization failure rather than missing
an invisible concurrent link. Document changes fence on the owning issue row,
and link triggers also bump old and new issue epochs. Supported writers must
not disable triggers or bypass this database protocol; arbitrary superuser
SQL is outside the threat model. The epoch
survives delete+recreate: the epoch row has no foreign key to issues, a
BEFORE UPDATE trigger rejects any attempt to wind it back, and an AFTER
DELETE trigger restores a deleted row at epoch+1, so no writer can reset the
generation and make a stale pin compare equal. The internal bump uses a
single-row upsert; explicit issue fences update the issue row and fail if it
is missing. The counter
is a decimal string, exact beyond 2^53 where JavaScript numbers collapse
adjacent generations.

The response includes a strong `ETag`. Repeat the GET with that exact value in
`If-Match`: a matching snapshot returns 200, a changed snapshot returns 412,
malformed or weak conditions return 400, and a foreign or unknown issue returns
404. All write methods and the former verify route are rejected. The gateway
forwards the condition to upstream and also checks the returned snapshot locally.

## Result semantics (read this before trusting a result)

A successful conditional GET proves the pinned snapshot still equals the current state **as of
that read** — nothing more. Check and use are separate operations, and no
read-only gateway can see a write that lands after its last read. Even an
immediate conditional read followed by publication leaves a race; repeating it cannot
make the privileged action atomic. The pin is diagnostic evidence only, not
an authorization to publish or consume a privileged CI verdict.

Atomic use is unavailable: publishing a GitHub CI verdict is an external
side effect and cannot commit in the database transaction that checks the
snapshot epoch. No core transactional privileged consumer is connected to
this snapshot. Keep the privileged acceptance workflow disabled until an
actual consumer enforces the same revision at its own use boundary and its
security prerequisites are independently reviewed. This gateway guarantees
only one MVCC snapshot per response and tenant confinement before output.

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
  "upstream": { "origin": "https://upstream.example:8443", "ca": "/private/upstream-ca.crt", "cert": "/private/client.crt", "key": "/private/client.key", "tokenFile": "/private/service-token" }
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
Rotate by issuing a new token and revoking the old one. The upstream token file
must contain the dedicated service bearer bound to the configured client
certificate and company; provision and revoke it as described in the linked
operator guide. It is separate from the runner-facing gateway credential. Do not
use a regular board agent key.

Upstream conditional reads send the pin-derived strong `If-Match`; a changed
snapshot returns 412 upstream and to the gateway client. This detects
changes at read time only, not atomic authorization of a later action.

Настройка и ключи принадлежат оператору; runner получает только отдельный
bearer gateway. Запись содержит SHA-256 токена, неизменяемый companyId и срок
действия в миллисекундах; отзыв сохраняется отдельным маркером. Запрещено менять
записи или давать runner доступ к каталогу, ключам TLS и upstream. Fixture не
является проверкой production. Файл `upstream.tokenFile` содержит отдельный
service bearer, привязанный к компании и клиентскому сертификату; это не bearer
runner. Условное чтение отправляет сильный `If-Match`: изменение даёт 412 от
upstream и 412 клиенту шлюза. Проверка не делает последующее действие атомарным.
Реальная сетевая изоляция требует отдельного подтверждения инфраструктуры до
развёртывания.

## Threat model and limitations

A malicious runner can choose methods, paths, headers and payloads and holds only
its gateway bearer. The gateway checks the fixed credential company against the
snapshot issue before returning minimal fields, rejects unlisted routes/methods,
uses fixed-origin TLS with a client certificate, and rechecks credentials before
response. Audit records contain only response status. TLS keys, credential store,
config, audit and upstream are trusted operator assets; an operator or upstream
compromise is outside this boundary. A shared filesystem must have coherent
visibility for revocations.

The disposable network topology in OPE-15287 passed: a client on the edge network
reached a dual-homed gateway, while direct core DNS failed and direct core IP
timed out. That HTTP-only topology test does not establish mTLS or production
network policy; TLS alone does not prevent direct upstream access. The real-core test exercises a
PostgreSQL-backed core route with synthetic credentials, not production. This
evidence does not constitute security PASS: keep privileged CI disabled until
network isolation, independent security review, actual-credential negative
checks, and the consumer-side revision enforcement above are complete.

## Verification

`devbuild 'node --test scripts/myrmidon/privileged-ci/acceptance-reader/*.test.mjs'`
uses a separate local TLS fixture with synthetic credentials. It is not a GitHub
OIDC exchange, a production test, or proof of network isolation. The fixture
exercises conditional GET, content ABA, rejected write methods, tenant isolation,
credential lifecycle and failure classes.

The real-core integration test is discovered by server Vitest at
`server/src/__tests__/reader-real-core.test.ts`. Run:

```sh
devbuild 'pnpm --filter @myrmidon/server exec vitest run src/__tests__/reader-real-core.test.ts'
```

It starts a real PostgreSQL-backed core route and TLS gateway with synthetic
credentials; it is not evidence of network isolation or a live GitHub exchange.
