# Acceptance reader (experimental)

This standalone gateway is not a production deployment. It exposes only the two
company-bound GET projections in `reader.mjs`. The upstream must implement the
expected issue and acceptance-document responses, including `issueId`,
`companyId`, `key`, `id`, `latestRevisionId`, and `body` on documents. This
contract has only been exercised against a fixture, not a live Myrmidon service.

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
is checked before serving responses; storage errors deny access. Rotate by issuing
a new token and revoking the old one. Do not use a regular board agent key.

Настройка и ключи принадлежат оператору; runner получает только отдельный
bearer gateway. Запись содержит SHA-256 токена, неизменяемый companyId и срок
действия в миллисекундах; отзыв сохраняется отдельным маркером. Запрещено менять
записи или давать runner доступ к каталогу, ключам TLS и upstream. Fixture не
является проверкой production. Реальная сетевая изоляция требует отдельного
подтверждения инфраструктуры до развёртывания.

## Threat model and limitations

A malicious runner can choose methods, paths, headers and payloads and holds only
its gateway bearer. The gateway checks the fixed credential company against the
upstream issue before returning minimal fields or requesting the document, rejects
unlisted routes/methods, uses fixed-origin TLS with a client certificate, and
rechecks credentials and document revision before response. Audit records contain
only response status. TLS keys, credential store, config, audit and upstream are
trusted operator assets; an operator or upstream compromise is outside this
boundary. A shared filesystem must have coherent visibility for revocations.

TLS alone does not establish network isolation: a runner must be prevented by
network policy from reaching upstream directly. No such policy or live upstream
integration has been demonstrated here. Do not deploy until these are verified,
and until an independent security review and actual-credential negative checks
are completed. No production credential has been issued by this component.

## Verification

`devbuild 'node --test scripts/myrmidon/privileged-ci/acceptance-reader/*.test.mjs'`
uses a separate local TLS fixture with synthetic credentials. It is not a GitHub
OIDC exchange, a production test, or proof of network isolation.
