---
settings-section: Track 5 — operations
---

## settings-en

| `MYRMIDON_KNOWLEDGE_GATE_MODE` | OPE-12627 | `auto` | Mode of the knowledge-note gate (`auto`, `warning`, `enforce`). A saved Fine settings value applies without a restart | An explicit environment value (`warning`/`enforce`) is the forced override; otherwise save the mode in Fine settings; unset or `auto` uses the date-based rollout |
| `MYRMIDON_KNOWLEDGE_GATE_START_DATE` | OPE-12627 | `2026-10-31T00:00:00.000Z` | Rollout anchor date for the knowledge-note gate. A saved Fine settings value applies without a restart | An explicit environment date overrides the saved value; unreadable dates fall back to the built-in anchor date |

## settings-ru

| `MYRMIDON_KNOWLEDGE_GATE_MODE` | OPE-12627 | `auto` | Режим гейта контроля знаний (`auto`, `warning`, `enforce`). Сохранённое значение «Тонких настроек» применяется без перезапуска | Явное значение env (`warning`/`enforce`) — принудительное; иначе режим задаётся в «Тонких настройках»; без настройки или `auto` режим определяется по дате |
| `MYRMIDON_KNOWLEDGE_GATE_START_DATE` | OPE-12627 | `2026-10-31T00:00:00.000Z` | Дата начала действия гейта контроля знаний. Сохранённое значение «Тонких настроек» применяется без перезапуска | Явная дата env имеет приоритет над сохранённой; при нечитаемой дате используется встроенная дата по умолчанию |
