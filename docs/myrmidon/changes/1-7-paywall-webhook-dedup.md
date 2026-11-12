## changelog-en

### 1.7 PAYWALL-WEBHOOK-DEDUP: redelivered webhook bodies are stored once (OPE-12678)

- `POST /api/billing/webhook` now deduplicates deliveries: `billingWebhookService.ingest` computes the SHA-256 of the exact signed request bytes (after the signature check) and stores it in the new nullable `billing_events.body_sha256` column; a partial unique index on `(company_id, body_sha256)` where `body_sha256` is not null makes a redelivered signed body answer `200` with `stored: "duplicate"` / `duplicate: true` and write nothing.
- A body differing by even one byte is a distinct event and gets a new row; legacy rows with `body_sha256 = NULL` are exempt from the index and are never rewritten.
- The response of every well-formed delivery now carries a `duplicate` boolean (`true` only for a repeat of an already stored signed body), so the provider never sees 4xx/5xx for a redelivery and stops retrying.
- Migration 0481 only adds the column and the index; no existing rows are rewritten and no event identifiers, time windows, or timestamp-based replay protection are introduced.

## changelog-ru

### 1.7 PAYWALL-WEBHOOK-DEDUP: повторная доставка вебхука сохраняется один раз (OPE-12678)

- `POST /api/billing/webhook` больше не пишет дубли: `billingWebhookService.ingest` считает SHA-256 от точных подписанных байтов запроса (после проверки подписи) и сохраняет его в новой допускающей NULL колонке `billing_events.body_sha256`; частичный уникальный индекс по `(company_id, body_sha256)`, где `body_sha256` не null, превращает повторную доставку того же подписанного тела в ответ `200` со `stored: "duplicate"` / `duplicate: true` без записи новой строки.
- Тело, отличающееся хотя бы одним байтом, — отдельное событие и получает новую строку; старые строки с `body_sha256 = NULL` от индекса освобождены и не переписываются.
- Ответ на любое корректное намерение теперь содержит булев флаг `duplicate` (`true` только для повтора уже сохранённого подписанного тела), поэтому провайдер не видит 4xx/5xx на повторную доставку и прекращает ретраи.
- Миграция 0481 только добавляет колонку и индекс; существующие строки не переписываются, идентификаторы событий, временные окна и защита по метке времени не вводятся.

## divergence-new

<!-- after: 1.6.6 — SKILLS-UI A: обнаружение agentskills.io и импорт архивов по дайджесту (сервер) -->

### 1.7 — PAYWALL-WEBHOOK-DEDUP: повторная доставка того же подписанного тела не создаёт вторую строку billing_events (OPE-12678)

| ID | Что изменено | Файлы | Зачем | Тест-сторож | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-PAYWALL-WEBHOOK-DEDUP | `billingWebhookService.ingest` считает SHA-256 сырых подписанных байтов и пишет его в новую колонку `billing_events.body_sha256` (nullable); частичный уникальный индекс `billing_events_company_body_sha256_uq` по `(company_id, body_sha256)`, где `body_sha256` не null, сворачивает повторную доставку в ответ 200 `stored: "duplicate"` (`duplicate: true`) без записи; поиск дубля выполняется только после проверки подписи; миграция 0481 только добавляет колонку и индекс | `server/src/myrmidon/billing-webhook/routes.ts`, `server/src/myrmidon/billing-webhook/service.ts`, `packages/db/src/schema/billing_events.ts`, `packages/db/src/migrations/0481_smooth_agent_brand.sql`, `server/src/myrmidon/billing-webhook/billing-webhook.myrmidon.test.ts` | Ретрай провайдера или повтор перехваченного запроса не должен превращаться во вторую платёжную строку, когда появится логика по `invoice.paid` | `server/src/myrmidon/billing-webhook/billing-webhook.myrmidon.test.ts` | Никогда, наше расширение | (этот PR) |
