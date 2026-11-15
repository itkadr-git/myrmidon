## changelog-en

### 1.7 PAYWALL-WEBHOOK: HMAC-SHA256 signature verification for payment webhook (OPE-12630)

- `POST /api/billing/webhook` now verifies the `sha256=<hex>` HMAC-SHA256 signature over the exact raw request bytes (`x-myrmidon-signature-256` or `x-hub-signature-256`) using the secret resolved from `MYRMIDON_BILLING_WEBHOOK_SECRET_REF` (`env:<NAME>` or `file:<PATH>`) before invoking `billingWebhookService.ingest`.
- Unset or unresolvable `MYRMIDON_BILLING_WEBHOOK_SECRET_REF` responds with `503` without writing to `billing_events`.
- Missing or invalid signature responds with `401` without writing to `billing_events`; the secret value is compared in memory and never logged or returned.
- Verified accepted events are stored in `billing_events` with `signature_status = "verified"`.

## changelog-ru

### 1.7 PAYWALL-WEBHOOK: проверка HMAC-SHA256 подписи входящего платёжного вебхука (OPE-12630)

- Маршрут `POST /api/billing/webhook` теперь проверяет HMAC-SHA256 подпись `sha256=<hex>` от сырых байтов тела запроса (`x-myrmidon-signature-256` или `x-hub-signature-256`) с секретом из `MYRMIDON_BILLING_WEBHOOK_SECRET_REF` (`env:<ИМЯ>` или `file:<ПУТЬ>`) до вызова `billingWebhookService.ingest`.
- При незаданной или неразрешимой ссылке `MYRMIDON_BILLING_WEBHOOK_SECRET_REF` возвращается `503`, запись в `billing_events` не создаётся.
- При отсутствии или неверной подписи возвращается `401`, запись в `billing_events` не создаётся; значение секрета сравнивается в памяти и не попадает в логи и ответы.
- Принятые события сохраняются в `billing_events` со статусом подписи `signature_status = "verified"`.

## divergence-new

<!-- after: 1.6.6 — SKILLS-UI A: обнаружение agentskills.io и импорт архивов по дайджесту (сервер) -->

### 1.7 — PAYWALL-WEBHOOK: проверка HMAC-SHA256 подписи входящего платёжного вебхука (OPE-12630)

| ID | Что изменено | Файлы | Зачем | Тест-сторож | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-PAYWALL-WEBHOOK-SIGNATURE | Маршрут `POST /api/billing/webhook` проверяет HMAC-SHA256 подпись от сырых байтов тела запроса до вызова `service.ingest` по секрету из ссылки `MYRMIDON_BILLING_WEBHOOK_SECRET_REF` (`env:<ИМЯ>` / `file:<ПУТЬ>`), отвечает `503` при отсутствии ссылки на секрет, `401` при отсутствии или несовпадении подписи, и сохраняет принятые события с `signature_status = "verified"` | `server/src/myrmidon/billing-webhook/routes.ts`, `server/src/myrmidon/billing-webhook/service.ts`, `server/src/myrmidon/billing-webhook/index.ts`, `packages/db/src/schema/billing_events.ts`, `server/src/myrmidon/billing-webhook/billing-webhook.myrmidon.test.ts` | Закрыть приём неподписанных платёжных вебхуков перед включением биллинговой бизнес-логики (хвост OPE-12093) | `server/src/myrmidon/billing-webhook/billing-webhook.myrmidon.test.ts` | Никогда, наше расширение | (этот PR) |

## settings-en-new

<!-- after: 1.6.6 — ALERTS: monitoring alerts webhook (Zabbix + Alertmanager) -->

### 1.7 — PAYWALL-WEBHOOK: payment webhook HMAC signature verification (OPE-12630)

Settings of `server/src/myrmidon/billing-webhook/` — the incoming payment webhook (`POST /api/billing/webhook`).
Verifies HMAC-SHA256 signature (`x-myrmidon-signature-256` or `x-hub-signature-256`) over raw request bytes before recording events in `billing_events` with `signature_status = "verified"`.

| Variable | Feature | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_BILLING_WEBHOOK_SECRET_REF` | 1.7-PAYWALL-WEBHOOK | unset | Reference to the shared HMAC-SHA256 secret for `POST /api/billing/webhook`: `env:<NAME>` or `file:<PATH>`. Compared in memory and never logged or returned | Unset or unresolvable — webhook answers 503 and stores nothing |

## settings-ru-new

<!-- after: 1.6.6 — ALERTS: вебхук мониторинговых тревог (Zabbix + Alertmanager) -->

### 1.7 — PAYWALL-WEBHOOK: проверка HMAC-подписи входящего платёжного вебхука (OPE-12630)

Настройки `server/src/myrmidon/billing-webhook/` — входящего платёжного вебхука (`POST /api/billing/webhook`).
Проверяет HMAC-SHA256 подпись (`x-myrmidon-signature-256` или `x-hub-signature-256`) по сырым байтам тела запроса до записи событий в `billing_events` со статусом `signature_status = "verified"`.

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_BILLING_WEBHOOK_SECRET_REF` | 1.7-PAYWALL-WEBHOOK | не задана | Ссылка на общий секрет HMAC-SHA256 для `POST /api/billing/webhook`: `env:<ИМЯ>` или `file:<ПУТЬ>`. Сравнивается в памяти, не логируется и не отдаётся в ответах | Не задана или не разрешается — вебхук отвечает 503 и ничего не сохраняет |
