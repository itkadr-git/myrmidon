---
divergence-section: Трек 3 — шлюз инструментов и адаптер Hermes
---

## changelog-en

### The GitHub broker capability header is redacted from the board HTTP log

- `server/src/middleware/http-log-redaction.ts`: `req.headers["x-paperclip-github-capability"]`
  is added to `HTTP_LOG_REDACT_PATHS`. The gh wrapper and the git credential
  helper send the run-scoped `github_credentials` capability (valid for 30
  days) in this header on every `POST /runtime-tools/github/credentials`, and
  pino-http logged it in clear text.
- Operator action: capabilities already written to the existing logs stay
  valid until they expire; rotate `AGENT_JWT_SECRET` or purge the logs
  accordingly.

## changelog-ru

### Заголовок capability брокера GitHub скрыт в HTTP-журнале доски

- `server/src/middleware/http-log-redaction.ts`: `req.headers["x-paperclip-github-capability"]`
  добавлен в `HTTP_LOG_REDACT_PATHS`. Обёртка gh и git credential helper шлют в
  этом заголовке capability `github_credentials` прогона (срок 30 дней) при
  каждом `POST /runtime-tools/github/credentials`, а pino-http писал его в
  журнал открытым текстом.
- Действие оператора: capability, уже попавшие в прежние журналы, действуют до
  истечения срока; ротировать `AGENT_JWT_SECRET` или очистить журналы.
