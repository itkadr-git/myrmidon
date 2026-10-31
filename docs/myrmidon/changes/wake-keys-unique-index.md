---
divergence-section: Трек 1 — платформа
---

## changelog-en

### Wake keys `pause_resume` and stranded auto-policy retry are now unique in the database

- Two racing resumes of a paused agent, or two stale-run sweeps reaching the same stranded
  issue, could each insert a wake with the same idempotency key and start a duplicate run.
  Migration `0401_wakeup_key_partial_unique_indexes` adds partial unique indexes on
  `(company_id, idempotency_key)` for `pause_resume:%` and
  `myrmidon.stranded_autopolicy_retry:%` wakes; terminal wakes (`skipped`, `failed`,
  `cancelled`) stay outside the predicate.
- The migration first repairs duplicates a live board already holds: the most meaningful
  run-backed wake keeps the key, run-backed or running duplicates are re-keyed with audit
  metadata and keep their status, and only duplicates that never acquired a run are
  marked `skipped`. Running work is never cancelled.

## changelog-ru

### Ключи побудок `pause_resume` и повтора stranded auto-policy теперь уникальны в базе

- Два одновременных возобновления приостановленного агента или два прохода сторожа по одной
  застрявшей задаче могли вставить побудку с одним ключом идемпотентности и запустить
  дублирующий прогон. Миграция `0401_wakeup_key_partial_unique_indexes` добавляет частичные
  уникальные индексы по `(company_id, idempotency_key)` для побудок `pause_resume:%` и
  `myrmidon.stranded_autopolicy_retry:%`; завершённые побудки (`skipped`, `failed`,
  `cancelled`) в условие не входят.
- Сначала миграция чинит дубликаты, которые уже есть на живой доске: ключ сохраняет самая
  осмысленная побудка с прогоном, дубликаты с прогоном или в работе получают другой ключ с
  пометкой аудита и сохраняют статус, а `skipped` ставится только дубликатам, не
  получившим прогон. Идущая работа не отменяется.

## divergence

| 1.6.6-WAKE-KEYS-UNIQUE | Частичные уникальные индексы `agent_wakeup_requests_pause_resume_idempotency_uq` и `agent_wakeup_requests_stranded_autopolicy_retry_idempotency_uq` + ремонт существующих дубликатов | `packages/db/src/schema/agent_wakeup_requests.ts` (метка `myrmidon(WAKE-KEYS-UNIQUE)`), миграция `0401_wakeup_key_partial_unique_indexes.sql` и мета, комментарий в `server/src/myrmidon/stranded-autopolicy.ts` | Проверки на стороне вызывающего читают снимок до вставки и не закрывают гонку; дубль побудки запускает второй прогон для уже занятой работы | `packages/db/src/wakeup-key-uniqueness-migration.myrmidon.test.ts` (embedded PG: ремонт дубликатов, затем отказ следующему) | Когда вендор сам сделает эти ключи уникальными — удалить объявления с меткой и тест; миграция односторонняя | (этот PR) |
