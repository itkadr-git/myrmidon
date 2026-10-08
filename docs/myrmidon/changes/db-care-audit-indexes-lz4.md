---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Five audit indexes and lz4 column compression, persisted from the production database (1.6.5 DB-CARE)

- The datastore audit of 07-08.10.2026 created five indexes by hand on the
  production board database. Migration
  `packages/db/src/migrations/0308_db_care_audit_indexes.sql` persists the five
  statements verbatim, each as `CREATE INDEX IF NOT EXISTS`, so the deploy on
  production is a no-op and a fresh installation builds the same indexes.
- The five indexes: `activity_log_issue_last_activity_idx` (partial
  `(company_id, entity_id, created_at DESC)` without the read/inbox marker
  actions), `issue_comments_body_lower_trgm_idx` (partial GIN on
  `lower(body) gin_trgm_ops` without deleted rows),
  `heartbeat_runs_attention_feed_idx` (`(company_id, agent_id, created_at,
  context_snapshot->>'issueId', context_snapshot->>'taskId')`),
  `heartbeat_runs_ctx_paperclip_issue_id_idx` (partial
  `(company_id, context_snapshot->'paperclipIssue'->>'id')`) and
  `heartbeat_runs_updated_at_idx` (`updated_at`).
- No `CONCURRENTLY`: drizzle migrations run transactionally. `activity_log` and
  `issue_comments` are bucketed "large" by the migration-safety checker, so
  those two statements carry the explicit
  `paperclip:migration-safety-ignore large-create-index-not-concurrently` note.
- Migration `packages/db/src/migrations/0309_db_care_lz4_compression.sql` sets
  the compression method `lz4` on the three largest varlena columns of
  `heartbeat_runs` (`context_snapshot`, `result_json`, `stdout_excerpt`). The
  statement is a catalog-only change: a short `ACCESS EXCLUSIVE` lock, no row
  rewrite, and the rows already stored keep their method until they are
  rewritten. On production the three columns already carry `l`, so the
  statements are no-ops there.
- The Drizzle schema declares the five indexes
  (`packages/db/src/schema/activity_log.ts`, `heartbeat_runs.ts`,
  `issue_comments.ts`, label `myrmidon(DB-CARE)`), and the `0308`/`0309`
  snapshots record them, so `db:generate` stays clean and the schema tells the
  same story as production's `pg_indexes`. Compression is a storage parameter,
  so it adds no schema object and `0309_snapshot.json` repeats the `0308`
  snapshot.
- The identifier indexes of `issues` need no change: production carries
  `issues_identifier_idx` (unique btree) and `issues_identifier_search_idx`
  (GIN `gin_trgm_ops`), which are two different indexes and both are already
  declared in the schema.

## changelog-ru

### Пять индексов аудита и lz4-сжатие колонок — из боевой базы (1.6.5 DB-CARE)

- Аудит хранилищ 07-08.10.2026 создал пять индексов руками на боевой базе
  доски. Миграция
  `packages/db/src/migrations/0308_db_care_audit_indexes.sql` закрепляет эти
  пять выражений дословно, каждое как `CREATE INDEX IF NOT EXISTS`: выкат на бой
  — no-op, свежая инсталляция строит те же индексы.
- Пять индексов: `activity_log_issue_last_activity_idx` (частичный
  `(company_id, entity_id, created_at DESC)` без действий-маркеров прочтения и
  инбокса), `issue_comments_body_lower_trgm_idx` (частичный GIN по
  `lower(body) gin_trgm_ops` без удалённых строк),
  `heartbeat_runs_attention_feed_idx` (`(company_id, agent_id, created_at,
  context_snapshot->>'issueId', context_snapshot->>'taskId')`),
  `heartbeat_runs_ctx_paperclip_issue_id_idx` (частичный
  `(company_id, context_snapshot->'paperclipIssue'->>'id')`) и
  `heartbeat_runs_updated_at_idx` (`updated_at`).
- Без `CONCURRENTLY`: миграции drizzle идут в транзакции. `activity_log` и
  `issue_comments` в бакете «large» у проверки безопасности миграций, поэтому у
  этих двух операторов стоит явная пометка
  `paperclip:migration-safety-ignore large-create-index-not-concurrently`.
- Миграция `packages/db/src/migrations/0309_db_care_lz4_compression.sql` ставит
  метод сжатия `lz4` трём самым крупным varlena-колонкам `heartbeat_runs`
  (`context_snapshot`, `result_json`, `stdout_excerpt`). Оператор меняет только
  каталог: короткий `ACCESS EXCLUSIVE`, без перезаписи строк; уже записанные
  строки живут со своим методом, пока их не перепишут. На бою эти три колонки
  уже `l`, то есть операторы там — no-op.
- Схема Drizzle объявляет эти пять индексов
  (`packages/db/src/schema/activity_log.ts`, `heartbeat_runs.ts`,
  `issue_comments.ts`, метка `myrmidon(DB-CARE)`), снапшоты `0308`/`0309` их
  фиксируют: `db:generate` не даёт диффа, схема рассказывает ту же историю, что
  боевой `pg_indexes`. Сжатие — параметр хранения, объекта схемы оно не
  добавляет, поэтому `0309_snapshot.json` повторяет снапшот `0308`.
- Индексы по `issues(identifier)` правки не требуют: на бою
  `issues_identifier_idx` (уникальный btree) и `issues_identifier_search_idx`
  (GIN `gin_trgm_ops`) — два разных индекса, и оба уже объявлены в схеме.

## divergence

| DB-CARE | Пять индексов боевой базы по журналу активности, прогонам и комментариям (`activity_log_issue_last_activity_idx`, `heartbeat_runs_attention_feed_idx`, `heartbeat_runs_ctx_paperclip_issue_id_idx`, `heartbeat_runs_updated_at_idx`, `issue_comments_body_lower_trgm_idx`) и lz4-сжатие трёх колонок `heartbeat_runs` | `packages/db/src/schema/activity_log.ts`, `heartbeat_runs.ts`, `issue_comments.ts` (объявления индексов, метка `myrmidon(DB-CARE)`) + миграции `0308_db_care_audit_indexes.sql`, `0309_db_care_lz4_compression.sql` и мета; запросы и поведение вендора не правятся | Аудит хранилищ 08.10 нашёл горячие предикаты без индекса (лента внимания, приём пробуждений, разбор зависших прогонов, журнал по задаче, поиск по комментариям) и дорогие колонки на дефолтном pglz; объекты уже существуют на бою — код обязан их догонять, иначе свежая инсталляция расходится с боевой базой | `packages/db/src/db-care-audit-indexes-lz4.myrmidon.test.ts` (статика: файлы/журнал/снапшот + сверка SQL со снапшотом; embedded PG: определения из `pg_indexes`, двойное применение миграций идемпотентно, `attcompression = 'l'` у трёх колонок) | Когда вендор сам покроет эти предикаты или сменит метод сжатия — удалить объявления с меткой `myrmidon(DB-CARE)` и тест-сторож; миграции 0308/0309 односторонние (CONVENTIONS §8), индексы и метод сжатия назад не откатывают | (этот PR) |