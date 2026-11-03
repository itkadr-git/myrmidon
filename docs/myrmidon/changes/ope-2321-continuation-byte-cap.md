---
settings-section: Track 2 — wake and run core
---

## changelog-en

### Byte ceiling on the serialized continuation envelope (OPE-2321)

- Kernel `MAX_ARG_STRLEN` (131072 bytes) limits the byte size of each argv/env string, but continuation character budgets count UTF-16 code units. Non-ASCII task history (e.g. Cyrillic comments) could exceed the kernel limit and crash local agent runs with `spawn E2BIG`.
- Adds `MYRMIDON_CONTINUATION_ENVELOPE_BYTES` (default 98304 = 96 KiB, 0 disables): a final byte pass in `limitExecutionContinuationHistory` bounds `Buffer.byteLength(JSON.stringify(envelope))` while preserving origin comments, latest user requests, and resume deltas.

## changelog-ru

### Байтовый потолок сериализованного конверта продолжения (OPE-2321)

- Лимит ядра `MAX_ARG_STRLEN` (131072 байт) ограничивает размер в байтах каждой строки argv/env, но символьные бюджеты контекста продолжения считают единицы UTF-16. Не-ASCII история задачи (например, кириллические комментарии) могла превышать лимит ядра и приводить к падению локальных агентов с ошибкой `spawn E2BIG`.
- Добавлена настройка `MYRMIDON_CONTINUATION_ENVELOPE_BYTES` (по умолчанию 98304 = 96 КиБ, 0 отключает): финальный байтовый проход в `limitExecutionContinuationHistory` ограничивает `Buffer.byteLength(JSON.stringify(envelope))`, сохраняя комментарии побудки, последние запросы пользователя и дельту возобновления.

## settings-en

| `MYRMIDON_CONTINUATION_ENVELOPE_BYTES` | OPE-2321 | `98304` (96 KiB) | Byte ceiling on the serialized run continuation envelope measured in UTF-8 bytes (`Buffer.byteLength(JSON.stringify(envelope))`), the form that travels inside one argv/env string and hits the kernel `MAX_ARG_STRLEN` limit. Character budgets above count UTF-16 code units and cannot guarantee it for non-ASCII history, so a final byte pass trims the message lists with the same pinned guarantees: origin comments, the first and the last user request and the resume delta never lose direction; the marker `messagesTruncated` records the budget and the before/after sizes. When the pass runs it aims below the ceiling with headroom for its own annotations | `0` — the ceiling is off. Unset, non-numeric or negative — the default |

## settings-ru

| `MYRMIDON_CONTINUATION_ENVELOPE_BYTES` | OPE-2321 | `98304` (96 КиБ) | Байтовый потолок сериализованного конверта продолжения прогона в UTF-8 байтах (`Buffer.byteLength(JSON.stringify(envelope))`), форма, которая передаётся внутри одной строки argv/env и упирается в лимит ядра `MAX_ARG_STRLEN`. Символьные бюджеты выше считают единицы UTF-16 и не могут гарантировать этот предел для не-ASCII истории, поэтому финальный байтовый проход усекает списки сообщений с теми же гарантиями закрепления: комментарии побудки, первый и последний запросы пользователя и дельта возобновления сохраняются; маркер `messagesTruncated` фиксирует бюджет и размеры до/после. При срабатывании проход целится ниже потолка с запасом под собственные аннотации | `0` — потолок выключен. Не задан, не число или отрицательное — по умолчанию |
