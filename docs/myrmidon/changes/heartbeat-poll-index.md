---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en
### Run-ownership probe no longer reads the whole runs table (1.6.5 HEARTBEAT-POLL)

- The wake path's ownership question (`getConversationOwnershipBlocker`)
  filters one company, terminal legacy runs and the issue reference, plus
  correlated `exists` predicates — with no index carrying the issue
  reference, the planner read the whole runs table per call.
- Migration `0301_heartbeat_run_ownership_index.sql` adds one partial index
  on `(company_id, coalesce(native_issue_id::text,
  context_snapshot->>'issueId'), created_at DESC, id DESC)` where the run is
  legacy and terminal, making the equality selective and the `ORDER BY` free.
  No query, schema or behaviour change.
## changelog-ru

### Проверка владельца прогона больше не читает таблицу прогонов целиком (1.6.5 HEARTBEAT-POLL)

- Перед допуском задачи к прогону путь побудки задаёт один вопрос: «остался ли
  у задачи терминальный legacy-прогон разговорного адаптера, который может
  владеть процессом или арендой окружения?»
  (`getConversationOwnershipBlocker`, `server/src/services/conversation-continuation.ts`).
  Запрос фильтрует одну компанию, `runtime_mode = 'legacy'`, ссылку на задачу
  прогона и четыре терминальных статуса, затем объединяет через ИЛИ два
  JSON-поля-признака и коррелированный `exists` по `heartbeat_run_events`, плюс
  `exists` по `environment_leases` на каждую строку. Ни один индекс не нёс
  ссылку на задачу вместе с фильтром терминальных legacy-прогонов, поэтому
  планировщик читал всю таблицу прогонов и выполнял `exists` на каждой строке.
- Миграция `packages/db/src/migrations/0301_heartbeat_run_ownership_index.sql`
  добавляет один частичный индекс по
  `heartbeat_runs (company_id, coalesce(native_issue_id::text, context_snapshot->>'issueId'), created_at DESC, id DESC)`
  при `runtime_mode = 'legacy' and status in ('failed','timed_out','interrupted','cancelled')`.
- Индекс делает равенство выборочным, а `ORDER BY` запроса — бесплатным,
  поэтому ИЛИ по JSON-полям и коррелированные `exists` считаются только на
  совпавших строках. Ни запрос, ни схема, ни поведение не меняются.
- Ветка-признак из ИЛИ остаётся на существующем индексе
  `heartbeat_run_events (company_id, run_id)`. Третья колонка `event_type`
  означала бы `CREATE INDEX` по журналу прогонов — большой, растущий при
  записи таблице — внутри транзакции миграции, а это `ACCESS EXCLUSIVE` на всё
  время построения; если такое уточнение когда-нибудь понадобится, применять его
  вручную через `CREATE INDEX CONCURRENTLY`.
- Сторож: `packages/db/src/heartbeat-run-ownership-index.myrmidon.test.ts` засевает
  таблицу прогонов, измеряет запрос с индексом и без него и падает, если запрос
  снова начинает последовательное сканирование `heartbeat_runs`.

## divergence

| HEARTBEAT-POLL | Проверка владельца прогона (`getConversationOwnershipBlocker`) получает частичный индекс `heartbeat_runs_company_legacy_terminal_issue_idx` по `company_id` + ссылке на задачу (`coalesce(native_issue_id::text, context_snapshot->>'issueId')`) + `created_at DESC, id DESC` при `runtime_mode = 'legacy' and status in ('failed','timed_out','interrupted','cancelled')`. Запрос не менялся: равенство по ссылке на задачу и `ORDER BY` обслуживает индекс, поэтому ИЛИ по JSON-полям и коррелированные `exists` по `heartbeat_run_events`/`environment_leases` считаются только на совпавших строках. Индекс по `heartbeat_run_events (company_id, run_id, event_type)` сознательно НЕ добавлен: таблица журнала прогонов в бакете large, а миграция идёт в транзакции (`ACCESS EXCLUSIVE` на всё построение) — уточнение оставлено ручному `CREATE INDEX CONCURRENTLY` | `packages/db/src/schema/heartbeat_runs.ts` (объявление индекса, метка `myrmidon(HEARTBEAT-POLL)`) + `packages/db/src/migrations/0301_heartbeat_run_ownership_index.sql`; код вендора не правится | Инцидент 04.10: запрос опроса по `heartbeat_runs` держал `paperclip-db` на 420–440 % CPU (34 584 вызова, в среднем 2,4 с — первое место по нагрузке с большим отрывом); индекс под ссылку на задачу и терминальные legacy-прогоны отсутствовал, таблица — 1,1 ГБ | `packages/db/src/heartbeat-run-ownership-index.myrmidon.test.ts` (засеянная таблица: индекс из миграции на месте, запрос идёт по индексу без `Seq Scan` по `heartbeat_runs` и по `heartbeat_run_events`, без индекса возвращается последовательное сканирование, применение миграции идемпотентно) | Когда вендор сам покроет этот запрос индексом или уберёт коррелированные `exists` — удалить объявление индекса с меткой `myrmidon(HEARTBEAT-POLL)`, тест-сторож, фрагмент и раздел; миграцию 0301 (односторонняя, CONVENTIONS §8) не удаляют | (этот PR) |