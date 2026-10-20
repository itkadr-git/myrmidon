---
settings-section: 1.7 — REDACT
---

## settings-en

| `REDACT_NEST_SETTINGS` | OPE-8660 | `{}` | Per-nest dictionaries, rules, mode, contract and invoice number patterns; managed through the nest REDACT API and applied without restart. | Remove the per-nest record. |

## settings-ru

| `REDACT_NEST_SETTINGS` | OPE-8660 | `{}` | Словари, правила, режим и шаблоны номеров договора и счёта для гнезда; управляется через API REDACT без перезапуска. | Удалить запись настройки гнезда. |

- Settings: per-nest REDACT dictionaries, enabled rules, default mode, contract and invoice number patterns.
- API: `GET`/`PATCH /api/myrmidon/nests/:nestId/redact`.
- Storage: `nest_redact_settings` migration 0401.
