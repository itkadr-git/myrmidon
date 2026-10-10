---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Partial lifecycle index for the attention screen's exhausted-runs query (1.6.5 F-15)

- The attention screen (`server/src/services/attention-exhausted-runs.ts`)
  looks for runs whose bounded retry budget ran out: it filters
  `heartbeat_run_events` by `company_id` + `event_type = 'lifecycle'` +
  `message like 'Bounded retry exhausted%'` before joining the run rows. The
  two non-unique indexes on the table (`company_run`, `company_created`) do not
  carry `event_type`, so the leg read every event row of the whole table — a
  sequential scan, one of the measured legs behind the feed's p50 2.3 s / p95
  4.7 s, measured on a production trace.
- Migration `packages/db/src/migrations/0381_attention_exhausted_lifecycle_idx.sql`
  adds one partial b-tree index
  `heartbeat_run_events_company_lifecycle_run_idx (company_id, event_type, run_id)`
  `WHERE event_type = 'lifecycle'`: the scan shrinks to the lifecycle slice of
  one company. Additive index-only migration: no query text, no schema and no
  behaviour change.
- Measured on embedded PostgreSQL with 83 200 seeded events across 20 companies
  (synthetic data, no production rows): the exhausted-runs leg went from
  `Seq Scan ... Rows Removed by Filter: 83 095` at 20.2 ms to
  `Bitmap Heap Scan ... Bitmap Index Scan on heartbeat_run_events_company_lifecycle_run_idx`
  at 0.87 ms — 23x faster, 1443 → 62 shared buffers.
- `CREATE INDEX IF NOT EXISTS` (not CONCURRENTLY — drizzle migrations run
  transactionally). `heartbeat_run_events` is bucketed "large" by the
  migration-safety checker (10 833 local rows × 250), so the statement carries
  the explicit `paperclip:migration-safety-ignore` note as 0307/0308 do for
  their large tables; production deploys run through the operator's maintenance
  mode and the partial predicate keeps the build cost at the lifecycle slice.
- Guard: `packages/db/src/attention-exhausted-lifecycle-index.myrmidon.test.ts`
  checks the migration file, the journal entry and the snapshot statically,
  confirms on embedded Postgres that the leg is served by the index and falls
  back to the sequential scan after `DROP INDEX` (the assertions have teeth),
  and applies the migration statement twice on one database to prove
  idempotency.

## changelog-ru

### Частичный индекс lifecycle для запроса «исчерпанные прогоны» экрана «Внимание» (1.6.5 F-15)

- Экран «Внимание» (`server/src/services/attention-exhausted-runs.ts`)
  ищет прогоны с исчерпанным бюджетом
  повторов: фильтрует `heartbeat_run_events` по `company_id` +
  `event_type = 'lifecycle'` + `message like 'Bounded retry exhausted%'` до
  присоединения строк прогона. Два обычные индекса таблицы (`company_run`,
  `company_created`) не включают `event_type`, поэтому ножка читала все
  события таблицы целиком — последовательное чтение, одна из замеренных ножек
  p50 2,3 с / p95 4,7 с ленты (замерено на боевой трассировке).
- Миграция `packages/db/src/migrations/0381_attention_exhausted_lifecycle_idx.sql`
  добавляет один частичный b-tree индекс
  `heartbeat_run_events_company_lifecycle_run_idx (company_id, event_type, run_id)`
  `WHERE event_type = 'lifecycle'`: чтение сжимается до lifecycle-среза одной
  компании. Аддитивная индексная миграция: текст запросов, схема и поведение не
  меняются.
- Замер на встроенном PostgreSQL, 83 200 синтетических событий на 20 компаний
  (без боевых данных): ножка «исчерпанных прогонов» ушла с
  `Seq Scan ... Rows Removed by Filter: 83 095` за 20,2 мс на
  `Bitmap Heap Scan ... Bitmap Index Scan on heartbeat_run_events_company_lifecycle_run_idx`
  за 0,87 мс — в 23 раза быстрее, 1443 → 62 буфера.
- `CREATE INDEX IF NOT EXISTS` (не CONCURRENTLY — миграции drizzle идут
  транзакционно). `heartbeat_run_events` попадает в корзину "large" у
  проверяющего миграции (10 833 локальных строк × 250), поэтому выражение
  несёт явную заметку `paperclip:migration-safety-ignore`, как 0307/0308 у
  своих больших таблиц; выкат на бой идёт через режим обслуживания оператора,
  а частичный предикат держит стоимость постройки на lifecycle-срезе.
- Сторож: `packages/db/src/attention-exhausted-lifecycle-index.myrmidon.test.ts`
  проверяет статикой файл миграции, запись журнала и снапшот, на встроенном
  Postgres подтверждает, что ножка обслуживается индексом и возвращается к
  последовательному чтению после `DROP INDEX` (проверки кусаются), и дважды
  применяет выражение миграции к одной базе — идемпотентность.

## divergence

| F-15-EXH-IDX | Частичный индекс `heartbeat_run_events_company_lifecycle_run_idx (company_id, event_type, run_id) WHERE event_type = 'lifecycle'` для ножки «исчерпанные прогоны» ленты внимания | `packages/db/src/schema/heartbeat_run_events.ts` (объявление индекса, метка `myrmidon(1.6.5-F-15)`), `packages/db/src/migrations/0381_attention_exhausted_lifecycle_idx.sql` и мета (снапшот 0381, запись журнала); запросы и поведение вендора не правятся | Боевая трассировка: существующие индексы таблицы не покрывают `event_type`, планировщик читал таблицу событий целиком на каждый опрос ленты (p50 2,3 с / p95 4,7 с); вендорского индекса под этот предикат нет | `packages/db/src/attention-exhausted-lifecycle-index.myrmidon.test.ts` (статика: файл/журнал/снапшот + сверка выражения; embedded PG: ножка на индексе, откат на Seq Scan после DROP INDEX, двойное применение идемпотентно) | Когда вендор сам покроет предикат `event_type = 'lifecycle'` индексом или перепишет запрос — удалить объявление с меткой `myrmidon(1.6.5-F-15)` и тест-сторож; миграция 0381 односторонняя, индекс назад не откатывается | (этот PR) |
