---
divergence-section: KNOWLEDGE-2.0 — единый модуль знаний
---

## changelog-en

### Knowledge module part A: domain and store (KNOWLEDGE-2.0 K-1)

- New server module `server/src/myrmidon/knowledge/`: `domain.ts` (pure
  domain: the revision state machine, invariants, `[[slug]]` link grammar,
  the deterministic markdown tree format, the `SearchIndex` port), `store.ts`
  (create/draft/submit/publish/approve/rollback/archive/supersede, link
  resolution and backlinks, tree export/import, events), `service.ts`
  (composition over a `Db`), `index.ts` (module barrel).
- New additive migration `0312_knowledge_module.sql`: tables
  `knowledge_items`, `knowledge_revisions`, `knowledge_links`,
  `knowledge_sources`, `knowledge_suggestions`, `knowledge_events` and the
  `knowledge_search` read model, all keyed by `nest_id` (today equal to the
  company id). FTS: a generated `tsvector` column plus `pg_trgm` indexes
  behind the `SearchIndex` port; an IMMUTABLE wrapper around `unaccent` keeps
  the generated column legal. No triggers, no dialect SQL inside the module.
- New `packages/db/src/knowledge-search.ts`: the Postgres implementation of
  the port (lexical rank + trigram tolerance, delivered revisions only).
- A new draft never moves `delivered_revision_id`; publishing a revision that
  requires approval without approval fails with HTTP 422; `approve` by an
  actor that violates the approver rules fails with HTTP 403; `rollback`
  copies the target revision forward and moves the delivery pointer;
  export → import → export is byte-for-byte.
- Every mutation writes a `knowledge.*` event into `knowledge_events` and an
  `activityLog` row.
- Tests: `knowledge-domain.myrmidon.test.ts` (20 tests, incl. a 1 000-page
  tree round-trip under 300 ms p95) and
  `knowledge-store.db.myrmidon.test.ts` (17 tests over embedded Postgres with
  real migrations). HTTP routes arrive with K-2.

## changelog-ru

### Модуль знаний, часть A: домен и хранилище (KNOWLEDGE-2.0 K-1)

- Новый модуль `server/src/myrmidon/knowledge/`: `domain.ts` (чистый домен:
  машина состояний ревизий, инварианты, грамматика ссылок `[[slug]]`,
  детерминированный формат дерева markdown, порт `SearchIndex`), `store.ts`
  (create/draft/submit/publish/approve/rollback/archive/supersede, резолв
  ссылок и обратные ссылки, экспорт/импорт дерева, события), `service.ts`
  (композиция над `Db`), `index.ts` (баррель модуля).
- Аддитивная миграция `0312_knowledge_module.sql`: таблицы `knowledge_items`,
  `knowledge_revisions`, `knowledge_links`, `knowledge_sources`,
  `knowledge_suggestions`, `knowledge_events` и модель чтения
  `knowledge_search` — все с `nest_id` (сегодня равен id компании). FTS:
  генерируемая колонка `tsvector` и индексы `pg_trgm` за портом `SearchIndex`;
  IMMUTABLE-обёртка над `unaccent` делает генерируемую колонку легальной.
  В коде модуля 0 триггеров и 0 диалектного `sql\``.
- Новый `packages/db/src/knowledge-search.ts`: реализация порта для
  Postgres (лексический ранг + trigram-допуск, только доставленные ревизии).
- Новый черновик не двигает `delivered_revision_id`; publish ревизии,
  требующей утверждения, без утверждения даёт HTTP 422; `approve` актёром вразрез
  правилами утверждения — HTTP 403; `rollback` копирует целевую ревизию вперёд и
  переставляет указатель доставки; экспорт → импорт → экспорт байт в байт.
- Каждая мутация пишет событие `knowledge.*` в `knowledge_events` и строку
  `activityLog`.
- Тесты: `knowledge-domain.myrmidon.test.ts` (20 тестов, включая обход дерева
  из 1 000 страниц под 300 мс p95) и `knowledge-store.db.myrmidon.test.ts`
  (17 тестов на embedded Postgres с реальными миграциями). HTTP-маршруты — K-2.

## divergence-new

### 1.6.6 — KNOWLEDGE-2.0 K-1: модуль знаний, часть A (домен и хранилище)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-KNOWLEDGE-A | Единая сущность знания с ревизиями и указателем доставки: аддитивная миграция `0309` (семь таблиц `knowledge_*` с `nest_id`, сегодня = `company_id`), чистый домен (машина состояний, инварианты, ссылки `[[…]]`, детерминированное markdown-дерево, порт `SearchIndex`), хранилище create/draft/submit/publish/approve/rollback/archive/supersede, резолв ссылок в обе стороны (S7: ссылка, записанная до появления страницы, резолвится при её создании), экспорт/импорт дерева байт в байт, события `knowledge.*` в `knowledge_events` + `activityLog`, FTS `tsvector`+`pg_trgm`+`unaccent` за портом (IMMUTABLE-обёртка `knowledge_unaccent` для генерируемой колонки). HTTP-маршруты — часть B (K-2), читалка доставки — K-3. | Наши файлы: `server/src/myrmidon/knowledge/` (весь каталог), `packages/db/src/schema/knowledge.ts`, `packages/db/src/knowledge-search.ts`, `packages/db/src/migrations/0312_knowledge_module.sql` (+ meta journal/snapshot); в вендоре помечены: `packages/db/src/schema/index.ts` (экспорт таблиц), `packages/db/src/index.ts` (экспорт реализации порта) | Знания компании перестают быть разрозненными вики-страницами: единая модель с ревизиями, утверждением и точкой доставки готова принять перенос из плагина-моста (K-6) | `knowledge-domain.myrmidon.test.ts` (инварианты §3.2, черновик не двигает `delivered_revision_id`, approve без `approver_kind` → 403, rollback копирует и переставляет указатель, export→import→export байт в байт, 1 000 страниц < 300 мс p95, 0 диалектного SQL в домене), `knowledge-store.db.myrmidon.test.ts` (embedded Postgres, реальные миграции: всё выше + события `knowledge.*` + activity + ссылки + поиск через порт) | Никогда, наше поведение. Каталог и таблицы остаются; миграции идут только вперёд | (этот PR) |
