---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### Coalesce index of the conversation blocker declared in the Drizzle schema (1.6.5 DB-CARE)

- The datastore audit of 07-08.10.2026 compared the production `pg_indexes`
  list with the Drizzle declaration. It found
  `heartbeat_runs_company_issue_coalesce_created_idx` on the board database and
  no declaration for it in `packages/db/src/schema`: migration
  `0302_heartbeat_runs_company_issue_coalesce_created_index.sql` had created the
  index during OPE-4106/OPE-4131-B, but the schema was never updated, so the
  inventory could not line the two sides up and `db:generate` could not see the
  object at all.
- Migration `packages/db/src/migrations/0312_db_care_coalesce_index_declaration.sql`
  repeats the 0302 statement (`CREATE INDEX IF NOT EXISTS ... USING btree
  (company_id, (coalesce(native_issue_id::text, context_snapshot ->> 'issueId')),
  created_at DESC, id DESC)`), and
  `packages/db/src/schema/heartbeat_runs.ts` declares the index
  (`HeartbeatRuns.companyIssueCoalesceCreatedIdx`, label `myrmidon(DB-CARE)`).
  On every installation that already ran 0302 the statement is a no-op because
  the index name exists; a fresh installation would build the same index.
- One divergence stays open on purpose: the production copy was made by hand
  during OPE-4106 with three columns and lacks the trailing `id DESC` of the
  managed definition, so production's `pg_get_indexdef` differs from the
  declaration. Aligning it is an operator rebuild (`DROP INDEX` +
  `CREATE INDEX CONCURRENTLY` on `heartbeat_runs`) recorded below; a migration
  must not drop a live index, and dropping it from the chain would take exactly
  the lock the index exists to avoid.
- Snapshots `0309`-`0312` were produced with drizzle's own `generateDrizzleJson`
  (the call the drift test uses), because `drizzle-kit generate` cannot run
  against current `main`: `src/migrations/meta` carries a pre-existing
  snapshot-chain defect (the `0305` snapshot points to itself, and the `0304`
  and `0307` snapshot files are absent). That defect is out of this change's
  scope and is reported to the lead; the chain this change appends to is
  internally consistent (`0309 -> 0310 -> 0311 -> 0312`, verified pairwise with
  `generateMigration`).

## changelog-ru

### Индекс coalesce для блокера беседы объявлен в схеме Drizzle (1.6.5 DB-CARE)

- Аудит хранилищ 07-08.10.2026 сравнил боевой список `pg_indexes` с
  объявлениями Drizzle. На боевой базе нашёлся
  `heartbeat_runs_company_issue_coalesce_created_idx`, а объявления в
  `packages/db/src/schema` не было: индекс создала миграция
  `0302_heartbeat_runs_company_issue_coalesce_created_index.sql` во время
  OPE-4106/OPE-4131-B, схему тогда не обновили — поэтому инвентаризация не
  сходилась, а `db:generate` этот объект вообще не видел.
- Миграция `packages/db/src/migrations/0312_db_care_coalesce_index_declaration.sql`
  повторяет выражение из 0302 (`CREATE INDEX IF NOT EXISTS ... USING btree
  (company_id, (coalesce(native_issue_id::text, context_snapshot ->> 'issueId')),
  created_at DESC, id DESC)`), а `packages/db/src/schema/heartbeat_runs.ts`
  объявляет индекс (`HeartbeatRuns.companyIssueCoalesceCreatedIdx`, метка
  `myrmidon(DB-CARE)`). Там, где 0302 уже применилась, выражение — no-op: имя
  индекса занято; свежая инсталляция построит тот же индекс.
- Одно расхождение остаётся намеренно открытым: боевая копия создана руками во
  время OPE-4106 в три колонки, без хвостового `id DESC` управляемого
  объявления, поэтому боевой `pg_get_indexdef` отличается от объявления.
  Выравнивание — операция оператора (`DROP INDEX` +
  `CREATE INDEX CONCURRENTLY` по `heartbeat_runs`), она записана ниже: миграция
  не может удалять живой индекс, а удаление из цепочки взяло бы ровно ту
  блокировку, ради которой индекс и заведён.
- Снапшоты `0309`-`0312` собраны родным `generateDrizzleJson` drizzle (тем же
  вызовом, что и в тесте дрейфа), потому что `drizzle-kit generate` на текущем
  `main` не запускается: в `src/migrations/meta` есть давний дефект цепочки
  снапшотов (снапшот `0305` ссылается сам на себя, файлов снапшотов `0304` и
  `0307` нет). Дефект вне объёма этой правки и передан лиду; цепочка, которую
  наращивает эта правка, внутренне согласована (`0309 -> 0310 -> 0311 -> 0312`,
  проверено попарно через `generateMigration`).

## divergence

| DB-CARE | Индекс `heartbeat_runs_company_issue_coalesce_created_idx` (блокер беседы, `server/src/services/conversation-continuation.ts`) существовал на бою с OPE-4106, но не был объявлен в схеме Drizzle: миграция `0302_heartbeat_runs_company_issue_coalesce_created_index.sql` его создала, схему не обновили, поэтому сверка `pg_indexes` со схемой не сходилась. Дополнительно боевая копия — три колонки, без хвостового `id DESC` управляемого четырёхколоночного выражения | `packages/db/src/schema/heartbeat_runs.ts` (объявление `HeartbeatRuns.companyIssueCoalesceCreatedIdx`, метка `myrmidon(DB-CARE)`) + миграция `0312_db_care_coalesce_index_declaration.sql` (повтор выражения из 0302, `IF NOT EXISTS`) и мета; запросы и поведение вендора не правятся | Сверка инвентаря индексов (DBC-2) не может быть выполнена, пока схема не называет объекты боевой базы; без объявления будущая `db:generate` диффует против снапшота, где индекса нет | `packages/db/src/db-care-coalesce-index-declaration.myrmidon.test.ts` (статика: файл/журнал/снапшот, дословное совпадение с выражением 0302; embedded PG: четырёхколоночное определение из `pg_indexes`, двойное применение не создаёт второй индекс) | Когда боевую копию перестроят в четырёхколоночное выражение (операция оператора: `DROP INDEX heartbeat_runs_company_issue_coalesce_created_idx` + `CREATE INDEX CONCURRENTLY` с `created_at DESC, id DESC`), расхождение закроется; до этого сверка `pg_get_indexdef` по этому индексу на бою будет показывать три колонки | (этот PR) |