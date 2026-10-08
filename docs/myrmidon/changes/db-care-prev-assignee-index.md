---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Previous-assignee index on the activity log, persisted from the production database (1.6.5 DB-CARE)

- The datastore audit of 07-08.10.2026 created `activity_log_issue_prev_assignee_idx`
  by hand on the production board database: the attention feed resolves, for one
  agent, the issues whose assignee *left* that agent, reading the audit rows'
  payload `details->'_previous'->>'assigneeAgentId'` for `issue.updated` rows of
  a company and ordering by `created_at`.
- Migration `packages/db/src/migrations/0307_db_care_issue_prev_assignee_index.sql`
  persists the statement verbatim (`CREATE INDEX IF NOT EXISTS ... USING btree
  (company_id, ((details -> '_previous' ->> 'assigneeAgentId')), created_at)
  WHERE entity_type = 'issue' and action = 'issue.updated'`). On production it
  is a no-op; a fresh installation builds the same index.
- `CREATE INDEX IF NOT EXISTS`, no `CONCURRENTLY`: drizzle migrations run
  transactionally. `activity_log` is bucketed "large" by the migration-safety
  checker, so the statement carries the explicit
  `paperclip:migration-safety-ignore large-create-index-not-concurrently` note,
  as the earlier activity_log indexes do.
- The Drizzle schema declares the index (`packages/db/src/schema/activity_log.ts`,
  label `myrmidon(DB-CARE)`) and `0307_snapshot.json` records it, so
  `db:generate` stays clean and the schema tells the same story as production's
  `pg_indexes`.
- The remaining production objects of the same audit (five more indexes and the
  `lz4` column compression) land with the same pull request as migrations `0308`
  and `0309` — see `docs/myrmidon/changes/db-care-audit-indexes-lz4.md`.

## changelog-ru

### Индекс предыдущего исполнителя по журналу активности — из боевой базы (1.6.5 DB-CARE)

- Аудит хранилищ 07-08.10.2026 создал `activity_log_issue_prev_assignee_idx`
  руками на боевой базе доски: лента внимания находит для одного агента
  задачи, у которых исполнитель *ушёл* от него, читая у строк `issue.updated`
  плату `details->'_previous'->>'assigneeAgentId'` по компании и упорядочивая
  по `created_at`.
- Миграция `packages/db/src/migrations/0307_db_care_issue_prev_assignee_index.sql`
  закрепляет выражение дословно (`CREATE INDEX IF NOT EXISTS ... USING btree
  (company_id, ((details -> '_previous' ->> 'assigneeAgentId')), created_at)
  WHERE entity_type = 'issue' and action = 'issue.updated'`). На бою это no-op;
  свежая инсталляция строит тот же индекс.
- `CREATE INDEX IF NOT EXISTS`, без `CONCURRENTLY`: миграции drizzle идут в
  транзакции. `activity_log` в бакете «large» у проверки безопасности миграций,
  поэтому у оператора стоит явная пометка
  `paperclip:migration-safety-ignore large-create-index-not-concurrently` — как
  у прежних индексов по этой таблице.
- Схема Drizzle объявляет индекс (`packages/db/src/schema/activity_log.ts`,
  метка `myrmidon(DB-CARE)`), `0307_snapshot.json` его фиксирует: `db:generate`
  не даёт диффа, а схема рассказывает ту же историю, что боевой `pg_indexes`.
- Остальные объекты того же аудита (ещё пять индексов и сжатие колонок `lz4`)
  ложатся тем же пул-реквестом миграциями `0308` и `0309` — см.
  `docs/myrmidon/changes/db-care-audit-indexes-lz4.md`.

## divergence

| DB-CARE | Индекс `activity_log_issue_prev_assignee_idx` по журналу активности: лента внимания (`server/src/services/attention.ts`) ищет задачи, от которых ушёл исполнитель, по платам `details->'_previous'->>'assigneeAgentId'` строк `issue.updated` внутри компании, упорядочивая по `created_at`; индекс создан руками на боевой базе 07-08.10.2026 и переносится в код как частичный b-tree `(company_id, ((details -> '_previous' ->> 'assigneeAgentId')), created_at) where entity_type = 'issue' and action = 'issue.updated'` | `packages/db/src/schema/activity_log.ts` (одно объявление индекса, метка `myrmidon(DB-CARE)`) + миграция `0307_db_care_issue_prev_assignee_index.sql` и мета; запросы и поведение вендора не правятся | Аудит хранилищ 08.10 показал, что лента внимания не обслуживалась ни одним индексом: предикат по платам журнала читал таблицу целиком. Объект уже существует на бою — код обязан его догонять, иначе свежая инсталляция расходится с боевой базой | `packages/db/src/db-care-prev-assignee-migration.myrmidon.test.ts` (статика: файл/журнал/снапшот + сверка SQL-предиката со снапшотом; embedded PG: определение индекса из `pg_indexes`, двойное применение миграции идемпотентно) | Когда вендор сам покроет этот предикат индексом или лента внимания перейдёт на другой источник — удалить объявление с меткой `myrmidon(DB-CARE)` и тест-сторож; миграция 0307 односторонняя (CONVENTIONS §8), индекс не удаляют | (этот PR) |