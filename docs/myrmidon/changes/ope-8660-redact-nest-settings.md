---
settings-section: 1.7 — REDACT
---

## settings-en

| `MYRMIDON_DISTILL_AUTO_ACCEPT` | KNOWLEDGE-2.0 K-5 | unset | Comma-separated suggestion sections eligible for automatic acceptance by the task distiller; domain policy still limits accepted sections to `glossary`, `releases` and `how-made` with internal sources | Unset or invalid sections — automatic acceptance remains limited by the domain rules |
| `MYRMIDON_DISTILL_GATEWAY_URL` | KNOWLEDGE-2.0 K-5 | unset | OpenAI-compatible free-model gateway URL for the knowledge distiller; otherwise the stored knowledge-curator role settings supply the gateway | Unset — use stored role settings; no key material is logged |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | KNOWLEDGE-2.0 K-5 | `3600` | Background distillation sweep interval in seconds | Invalid or below the supported minimum — stored/default interval |
| `MYRMIDON_DISTILL_KEY_SECRET` | KNOWLEDGE-2.0 K-5 | unset | Name of the secret containing the gateway key; only the secret reference is read and the key value is never logged | Unset — use stored curator credentials or leave the sweep unconfigured |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | KNOWLEDGE-2.0 K-5 | `1800` | Per-pass time budget signal in seconds; exceeding it records the budget signal rather than truncating source selection | Invalid — stored/default budget |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | KNOWLEDGE-2.0 K-5 | `1000000` | Approximate input-token budget signal per distillation pass | Invalid — stored/default budget |
| `MYRMIDON_DISTILL_MAX_TASKS` | KNOWLEDGE-2.0 K-5 | `100` | Maximum closed tasks selected as source material in one pass | Invalid or non-positive — stored/default cap |
| `MYRMIDON_DISTILL_MODEL` | KNOWLEDGE-2.0 K-5 | unset | Free model identifier used by the distiller; otherwise the knowledge-curator role settings supply it | Unset — use stored role settings |
| `MYRMIDON_DISTILL_WINDOW_SEC` | KNOWLEDGE-2.0 K-5 | `86400` | Look-back window in seconds for tasks closed in the pass | Invalid or non-positive — stored/default window |

## settings-ru

| `MYRMIDON_DISTILL_AUTO_ACCEPT` | KNOWLEDGE-2.0 K-5 | не задана | Список разделов предложений через запятую, которые дистиллятор задач может принять автоматически; доменные правила всё равно ограничивают приём разделами `glossary`, `releases` и `how-made` с внутренними источниками | Не задана или разделы невалидны — действуют только доменные ограничения |
| `MYRMIDON_DISTILL_GATEWAY_URL` | KNOWLEDGE-2.0 K-5 | не задана | URL OpenAI-совместимого шлюза бесплатной модели; иначе берётся из сохранённых настроек роли `knowledge-curator` | Не задана — используются сохранённые настройки роли; ключи не логируются |
| `MYRMIDON_DISTILL_INTERVAL_SEC` | KNOWLEDGE-2.0 K-5 | `3600` | Интервал фонового обхода дистилляции в секундах | Невалидное или меньше минимума — сохранённый интервал/значение по умолчанию |
| `MYRMIDON_DISTILL_KEY_SECRET` | KNOWLEDGE-2.0 K-5 | не задана | Имя секрета со шлюзовым ключом; читается только ссылка на секрет, значение ключа не логируется | Не задана — используются сохранённые учётные данные куратора или обход остаётся ненастроенным |
| `MYRMIDON_DISTILL_MAX_DURATION_SEC` | KNOWLEDGE-2.0 K-5 | `1800` | Сигнальный бюджет длительности прохода в секундах; превышение записывается, а не обрывает выборку источников | Невалидное — сохранённый бюджет/значение по умолчанию |
| `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` | KNOWLEDGE-2.0 K-5 | `1000000` | Сигнальный бюджет входных токенов на проход | Невалидное — сохранённый бюджет/значение по умолчанию |
| `MYRMIDON_DISTILL_MAX_TASKS` | KNOWLEDGE-2.0 K-5 | `100` | Максимум закрытых задач, выбираемых как исходный материал за проход | Невалидное или не положительное — сохранённый лимит/значение по умолчанию |
| `MYRMIDON_DISTILL_MODEL` | KNOWLEDGE-2.0 K-5 | не задана | Идентификатор бесплатной модели; иначе берётся из сохранённых настроек роли `knowledge-curator` | Не задана — используются сохранённые настройки роли |
| `MYRMIDON_DISTILL_WINDOW_SEC` | KNOWLEDGE-2.0 K-5 | `86400` | Окно отбора закрытых задач в секундах | Невалидное или не положительное — сохранённое окно/значение по умолчанию |

## settings-en-new

### 1.7 — REDACT: per-nest redaction dictionaries and rules

Per-nest redaction settings are stored in the `nest_redact_settings` database table, keyed by `nest_id`, and managed via `GET/PATCH /api/myrmidon/nests/:nestId/redact`. The effective rules and dictionaries are read for each request; updates apply without a restart.

## settings-ru-new

### 1.7 — REDACT: словари и правила редактирования по гнезду

Настройки REDACT по гнезду хранятся в таблице БД `nest_redact_settings`, ключ `nest_id`, и управляются через `GET/PATCH /api/myrmidon/nests/:nestId/redact`. Правила и словари читаются для каждого запроса; изменения применяются без перезапуска.
