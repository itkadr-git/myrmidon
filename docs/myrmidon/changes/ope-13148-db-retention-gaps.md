---
settings-section: Track 5 — operations
---

## settings-en

| `datastoreCare.retention.documentRevisionKeepPerDocument` | 1.6.9-DB-RETENTION-GAPS | `20` | Minimum number of newest revisions retained per document; revisions younger than `documentRevisionDays` are retained too | `0` disables the count-based keep rule (age retention still applies); change via `PATCH /api/myrmidon/data-retention`. The revision referenced by `documents.latest_revision_id` and revisions referenced by `issue_plan_decompositions.accepted_plan_revision_id` are always retained; when both revision settings are `0`, revision cleanup is disabled |
| `datastoreCare.retention.documentRevisionDays` | 1.6.9-DB-RETENTION-GAPS | `90` | Minimum age in days before a document revision can be deleted, and only when it is older than the newest `documentRevisionKeepPerDocument` revisions for its document | `0` disables age retention (the newest-N rule still applies); change via `PATCH /api/myrmidon/data-retention`. The revision referenced by `documents.latest_revision_id` and revisions referenced by `issue_plan_decompositions.accepted_plan_revision_id` are always retained; when both revision settings are `0`, revision cleanup is disabled |
| `datastoreCare.retention.agentWakeupRequestsDays` | 1.6.9-DB-RETENTION-GAPS | `30` | Days to retain terminal agent wake requests; nonterminal requests are never removed by this policy | `0` keeps terminal requests forever; change via `PATCH /api/myrmidon/data-retention` |
| `datastoreCare.retention.environmentLeasesDays` | 1.6.9-DB-RETENTION-GAPS | `30` | Days to retain released environment leases; active leases are never removed by this policy | `0` keeps released leases forever; change via `PATCH /api/myrmidon/data-retention` |

## settings-ru-append

<!-- section: Трек 5 — эксплуатация -->

| `datastoreCare.retention.documentRevisionKeepPerDocument` | 1.6.9-DB-RETENTION-GAPS | `20` | Минимальное число последних ревизий каждого документа, которые сохраняются; ревизии моложе `documentRevisionDays` также сохраняются | `0` отключает ограничение по числу (срок хранения по возрасту продолжает действовать); меняется через `PATCH /api/myrmidon/data-retention`. Ревизия из `documents.latest_revision_id` и ревизии из `issue_plan_decompositions.accepted_plan_revision_id` сохраняются всегда; если обе настройки ревизий равны `0`, очистка ревизий отключена |
| `datastoreCare.retention.documentRevisionDays` | 1.6.9-DB-RETENTION-GAPS | `90` | Минимальный возраст ревизии в днях для удаления; удалить её можно только если она старше последних `documentRevisionKeepPerDocument` ревизий документа | `0` отключает ограничение по возрасту (правило последних N продолжает действовать); меняется через `PATCH /api/myrmidon/data-retention`. Ревизия из `documents.latest_revision_id` и ревизии из `issue_plan_decompositions.accepted_plan_revision_id` сохраняются всегда; если обе настройки ревизий равны `0`, очистка ревизий отключена |
| `datastoreCare.retention.agentWakeupRequestsDays` | 1.6.9-DB-RETENTION-GAPS | `30` | Сколько дней хранить терминальные запросы на побудку агента; нетерминальные запросы эта политика никогда не удаляет | `0` — хранить терминальные запросы вечно; меняется через `PATCH /api/myrmidon/data-retention` |
| `datastoreCare.retention.environmentLeasesDays` | 1.6.9-DB-RETENTION-GAPS | `30` | Сколько дней хранить освобождённые аренды окружений; активные аренды эта политика никогда не удаляет | `0` — хранить освобождённые аренды вечно; меняется через `PATCH /api/myrmidon/data-retention` |
