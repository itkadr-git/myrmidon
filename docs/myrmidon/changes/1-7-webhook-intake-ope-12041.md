## changelog-en

### 1.7 WEBHOOK-INTAKE: arbitrary signed incoming webhook intake (OPE-12041)

- New server route `POST /api/myrmidon/monitoring/intake/webhook`: accepts arbitrary incoming signed webhooks and stores candidate drafts.
- Verifies signature using HMAC-SHA256 (`x-hub-signature-256` or `x-myrmidon-signature-256`) against secret resolved from `MYRMIDON_WEBHOOK_INTAKE_TOKEN_REF` (`env:<NAME>` or `file:<PATH>`).
- Deduplicates events by (source, event_id), returning `deduplicated: true` on repeat without creating a duplicate draft.
- Preserves raw payload and extracts metadata (source, event_id, event_type, timestamp) into candidate drafts table.

## changelog-ru

### 1.7 WEBHOOK-INTAKE: приём произвольного входящего подписанного вебхука (OPE-12041)

- Новый серверный маршрут `POST /api/myrmidon/monitoring/intake/webhook`: принимает произвольные входящие подписанные вебхуки и сохраняет черновики-претенденты.
- Проверяет HMAC-SHA256 подпись (`x-hub-signature-256` или `x-myrmidon-signature-256`) с секретом из `MYRMIDON_WEBHOOK_INTAKE_TOKEN_REF` (`env:<ИМЯ>` или `file:<ПУТЬ>`).
- Дедуплицирует события по (source, event_id), возвращая `deduplicated: true` при повторе без создания дубликата черновика.
- Сохраняет сырой payload и метаданные (source, event_id, event_type, timestamp) в таблицу черновиков-претендентов.

## divergence-new

<!-- after: 1.6.6 — MONITORING: метрики простоя инженеров для Zabbix (OPE-9868 / OPE-10927) -->

### 1.7 — WEBHOOK-INTAKE: приём входящих вебхуков (OPE-12041)

| ID | Что изменено | Файлы | Зачем | Тест-сторож | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-WEBHOOK-INTAKE | Серверный маршрут `POST /api/myrmidon/monitoring/intake/webhook` для приёма произвольных входящих вебхуков с проверкой HMAC-SHA256 подписи, дедупликацией по (source, event_id) и сохранением сырого payload в таблицу черновиков-претендентов | `server/src/app.ts`, `server/src/middleware/auth.ts`, `server/src/myrmidon/app-plugin.ts`, `packages/db/src/schema/webhook_intake_drafts.ts`, `server/src/myrmidon/monitoring/intake/*` | Приём произвольных входящих вебхуков в черновики задач согласно roadmap-v1 §3.3 (эпик OPE-2913 / OPE-3919 / OPE-12041) | `server/src/myrmidon/monitoring/intake/routes.myrmidon.test.ts` | Никогда, наше расширение | (этот PR) |

## settings-en-new

<!-- after: 1.6.6 — ALERTS: monitoring alerts webhook (Zabbix + Alertmanager) -->

### 1.7 — WEBHOOK-INTAKE: arbitrary signed incoming webhook intake (OPE-12041)

Settings of `server/src/myrmidon/monitoring/intake/` — the arbitrary incoming webhook intake.
`POST /api/myrmidon/monitoring/intake/webhook` accepts incoming webhooks, validates HMAC-SHA256 signature, deduplicates by `(source, event_id)`, and stores raw payload in candidate drafts.

| Variable | Feature | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_WEBHOOK_INTAKE_TOKEN_REF` | 1.7-WEBHOOK-INTAKE | unset | Reference to shared secret for HMAC-SHA256 verification (`env:<NAME>` or `file:<PATH>`). Compared in memory, never logged | Unset — webhook intake answers 503 |
| `MYRMIDON_WEBHOOK_INTAKE_COMPANY_ID` | 1.7-WEBHOOK-INTAKE | unset | Company ID to associate intake drafts with | Unset — webhook intake answers 503 |

## settings-ru-new

<!-- after: 1.6.6 — ALERTS: вебхук мониторинговых тревог (Zabbix + Alertmanager) -->

### 1.7 — WEBHOOK-INTAKE: приём произвольного входящего вебхука (OPE-12041)

Настройки `server/src/myrmidon/monitoring/intake/` — модуль приёма входящих вебхуков.
`POST /api/myrmidon/monitoring/intake/webhook` принимает входящие вебхуки, проверяет HMAC-SHA256 подпись, дедуплицирует по `(source, event_id)` и сохраняет сырой payload в черновики.

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_WEBHOOK_INTAKE_TOKEN_REF` | 1.7-WEBHOOK-INTAKE | не задана | Ссылка на общий секрет для проверки HMAC-SHA256 (`env:<ИМЯ>` или `file:<ПУТЬ>`). Сравнивается в памяти, не логируется | Не задана — эндпоинт возвращает 503 |
| `MYRMIDON_WEBHOOK_INTAKE_COMPANY_ID` | 1.7-WEBHOOK-INTAKE | не задана | Идентификатор компании для привязки черновиков | Не задана — эндпоинт возвращает 503 |
