---
settings-section: Track 4 — chats and skills
---

## changelog-en

### Telegram pool bridge for ChatGPT and Gemini (OPE-8077)

- Adds Telegram bridge support for ChatGPT and Google AI / Gemini pool modules using the pool-chat adapter.
- Configurable per module: allowed chat ID, model, bot token reference, and pool endpoint. Default disabled (`enabled: false`); operator-controlled activation.
- Strictly enforces chat allowlist: messages from unauthorized chats or strangers are refused without calling pool-chat and without debiting quota.
- Incoming Telegram updates are deduplicated: repeated deliveries of the same `update_id` return the existing result without repeating upstream provider I/O or charging quota again.
- Long answers exceeding Telegram's 4096 character limit are cleanly split into sequential parts and delivered via the outbox.
- History isolation prevents conversations from ChatGPT and Gemini from crossing, and prevents Telegram chats from intersecting with web-chat.
- Token redaction ensures bot tokens and API keys are never exposed in error responses, logs, or status payloads.
- Includes ChannelSettingsPanel UI integration, operator live acceptance runbook, and automated test coverage for redaction, allowlist, update deduplication, long answer chunking, and both pool modules.

## changelog-ru

### Telegram-мост для модулей пулов ChatGPT и Gemini (OPE-8077)

- Добавлена поддержка Telegram-моста для модулей пулов ChatGPT и Google AI / Gemini на базе адаптера pool-chat.
- Настраивается для каждого модуля: разрешённый chat ID, модель, ссылка на токен бота и URL пула. По умолчанию выключен (`enabled: false`); включение контролируется оператором.
- Строго соблюдает allowlist чата: сообщения из неразрешённых чатов или от посторонних пользователей отклоняются без вызова pool-chat и без списания квоты.
- Дедупликация входящих Telegram update: повторная доставка с тем же `update_id` возвращает существующий результат без повторного обращения к провайдеру и без повторного списания квоты.
- Длинные ответы, превышающие лимит Telegram в 4096 символов, аккуратно разбиваются на последовательные части и доставляются через outbox.
- Изоляция истории гарантирует, что диалоги ChatGPT и Gemini не пересекаются между собой и не смешиваются с веб-чатом.
- Redaction обеспечивает защиту секретов: токены бота и API-ключи не попадают в ошибки, логи или структуру статуса.
- Включает интеграцию в UI ChannelSettingsPanel, операторский сценарий живой приёмки и автотесты на redaction, allowlist, dedupe, длинные ответы и оба пула.

## settings-en

| `MYRMIDON_TELEGRAM_POOL_CHATGPT_ENABLED` | OPE-8077 | `0` | Enables the Telegram bridge for the ChatGPT pool module | `0` or unset — disabled; `1` — enabled |
| `MYRMIDON_TELEGRAM_POOL_GEMINI_ENABLED` | OPE-8077 | `0` | Enables the Telegram bridge for the Google AI / Gemini pool module | `0` or unset — disabled; `1` — enabled |

## settings-ru

| `MYRMIDON_TELEGRAM_POOL_CHATGPT_ENABLED` | OPE-8077 | `0` | Включает Telegram-мост для модуля пула ChatGPT | `0` или не задано — выключен; `1` — включён |
| `MYRMIDON_TELEGRAM_POOL_GEMINI_ENABLED` | OPE-8077 | `0` | Включает Telegram-мост для модуля пула Google AI / Gemini | `0` или не задано — выключен; `1` — включён |
