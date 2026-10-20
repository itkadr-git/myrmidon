---
settings-section: 1.7 — REDACT
---

## settings-en-new

### 1.7 — REDACT: per-nest redaction dictionaries and rules

Per-nest redaction settings are stored in the `nest_redact_settings` database table, keyed by `nest_id`, and managed via `GET/PATCH /api/myrmidon/nests/:nestId/redact`. The effective rules and dictionaries are read for each request; updates apply without a restart.

## settings-ru-new

### 1.7 — REDACT: словари и правила редактирования по гнезду

Настройки REDACT по гнезду хранятся в таблице БД `nest_redact_settings`, ключ `nest_id`, и управляются через `GET/PATCH /api/myrmidon/nests/:nestId/redact`. Правила и словари читаются для каждого запроса; изменения применяются без перезапуска.
