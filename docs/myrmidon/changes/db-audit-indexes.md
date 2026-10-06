---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Four audit indexes for the heartbeat_runs and issues hot paths (1.6.5 DB-AUDIT-INDEXES)

- The PostgreSQL audit measured four hot query groups that the planner could
  not serve with any existing index: the attention feed over `heartbeat_runs`
  (company + agent id + created_at window — 1 926 s per 13.6 h statistics
  window), the chat-reconcile milestone projection (company +
  `context_snapshot->>'issueId'` + status — 2 197 s), and the issue claim
  lockup (`FOR UPDATE` on company + execution_run_id / checkout_run_id —
  2.6k s, a Seq Scan that also locked neighbouring rows).
- Migration `packages/db/src/migrations/0306_audit_indexes_heartbeat_issues.sql`
  adds four plain b-tree indexes:
  `heartbeat_runs (company_id, agent_id, created_at)`,
  `heartbeat_runs (company_id, (context_snapshot->>'issueId'), status)`,
  `issues (company_id, execution_run_id)`,
  `issues (company_id, checkout_run_id)`.
- `CREATE INDEX IF NOT EXISTS`, no `CONCURRENTLY`: drizzle migrations run
  transactionally. Both tables are bucketed "medium" by the migration-safety
  checker, so a plain build is the accepted form here; production deploys run
  through the operator's maintenance mode.
- The audit's blocker expression index (company, coalesced issue reference,
  created_at) is not in this migration — the hot-queries PR persists it as
  migration 0302, and this branch deliberately does not duplicate it.
- Guard: `packages/db/src/audit-indexes-migration.myrmidon.test.ts` checks the
  migration file, the journal entry and the snapshot statically, confirms the
  four audited query shapes plan onto the new indexes on embedded Postgres, and
  applies the migration twice on one database to prove idempotency.

## changelog-ru

### Четыре индекса из аудита базы для горячих путей heartbeat_runs и issues (1.6.5 DB-AUDIT-INDEXES)

- Аудит PostgreSQL замерил четыре группы горячих запросов, которым не подходил
  ни один существующий индекс: лента внимания по `heartbeat_runs` (компания +
  id агента + окно created_at — 1 926 с за окно статистики 13,6 ч), проекция
  вех сверки чатов (компания + `context_snapshot->>'issueId'` + status —
  2 197 с) и блокировка строк issues при захвате задачи (`FOR UPDATE` по
  компании + execution_run_id / checkout_run_id — 2,6 тыс. с; Seq Scan заодно
  блокировал соседние строки).
- Миграция `packages/db/src/migrations/0306_audit_indexes_heartbeat_issues.sql`
  добавляет четыре обычных b-tree индекса:
  `heartbeat_runs (company_id, agent_id, created_at)`,
  `heartbeat_runs (company_id, (context_snapshot->>'issueId'), status)`,
  `issues (company_id, execution_run_id)`,
  `issues (company_id, checkout_run_id)`.
- `CREATE INDEX IF NOT EXISTS`, без `CONCURRENTLY`: миграции drizzle идут в
  транзакции. Обе таблицы в бакете «medium» у проверки безопасности миграций,
  поэтому обычное построение — принятая форма; выкат на бой идёт через режим
  обслуживания оператора.
- Выраженческий индекс блокировщика из аудита (компания + свёрнутая ссылка на
  задачу + created_at) в эту миграцию НЕ входит: его закрепляет PR горячих
  запросов как миграцию 0302, и ветка сознательно его не дублирует.
- Сторож: `packages/db/src/audit-indexes-migration.myrmidon.test.ts` статически
  проверяет файл миграции, запись журнала и снапшот, подтверждает на embedded
  Postgres, что четыре замеренные формы запросов используют новые индексы, и
  применяет миграцию дважды на одной базе — доказательство идемпотентности.

## divergence

| DB-AUDIT-INDEXES | Четыре adдитивных индекса из аудита базы на вендорских таблицах: `heartbeat_runs_company_agent_created_idx` (лента внимания, `server/src/services/attention.ts` фильтрует компанию + агента + окно created_at, а индекс по started_at не годился), `heartbeat_runs_ctx_issue_status_idx` (проекция вех сверки чатов джойнит `context_snapshot->>'issueId'` с чатами и фильтрует status; вендорский индекс 0209 несёт created_at DESC без status), `issues_company_execution_run_idx` и `issues_company_checkout_run_idx` (замок захвата задачи `FOR UPDATE` по компании и run-колонкам шёл Seq Scan — частичные уникальные индексы его не покрывали) | `packages/db/src/schema/heartbeat_runs.ts` (два объявления индексов, метки `myrmidon(DB-AUDIT-INDEXES)`), `packages/db/src/schema/issues.ts` (два объявления, метка `myrmidon(DB-AUDIT-INDEXES)`) + миграция `0306_audit_indexes_heartbeat_issues.sql` и мета; запросы и поведение вендора не правятся | Аудит базы (снимок pg_stat_statements): ленты внимания 1 926 с, проекция вех 2 197 с, замок захвата 2,6 тыс. с за окно 13,6 ч; ни один из четырёх предикатов не обслуживался индексом | `packages/db/src/audit-indexes-migration.myrmidon.test.ts` (статика: файл/журнал/снапшот; embedded PG: четыре формы запросов идут по новым индексам, двойное применение миграции идемпотентно) | Когда вендор сам покроет эти предикаты индексами — удалить четыре объявления с метками `myrmidon(DB-AUDIT-INDEXES)` и тест-сторож; миграция 0306 односторонняя (CONVENTIONS §8), индексы не удаляют | (этот PR) |
