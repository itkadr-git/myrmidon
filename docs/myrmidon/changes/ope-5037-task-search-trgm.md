## changelog-en

### Text search: trigram indexes now cover the coalesce-wrapped predicates too (1.6.5 PERF-DIET-P)

- Both search paths match task text with `ILIKE '%…%'`, and both already ran on
  pg_trgm GIN indexes: the plain-column ones shipped by the vendor in migrations
  `0051`/`0079` — `issues(title)`, `issues(description)`, `issues(identifier)`,
  `issue_comments(body)`, `documents(title)`, `documents(latest_body)` — and the
  task-search statement matches those columns bare, so it uses them.
- Company search has a second family of predicates that wraps the column in
  `coalesce`: `coalesce(title, '') ILIKE '%…%'` over `documents` and
  `coalesce(identifier, '') ILIKE '%…%'` over `issues`
  (`server/src/services/company-search.ts`, `company-artifacts.ts`). A wrapped
  expression cannot use the plain-column index, so the planner sequentially
  scanned `documents` — the table whose `latest_body` column is the heavy one —
  and `issues`.
- Migration `packages/db/src/migrations/0321_search_coalesce_trgm_indexes.sql`
  adds one expression index per emitted shape,
  `gin ((coalesce(col, '')) gin_trgm_ops)`. It also repeats
  `CREATE EXTENSION IF NOT EXISTS pg_trgm` (idempotent; vendor migration
  `0051` already creates it) so the file is self-contained. It is an additive
  index-only migration: no query text, no schema and no behaviour change, and the search
  semantics stay identical (a NULL column and the empty string are both
  non-matching, and the predicates sit in positive OR/AND chains).
- Measured on embedded PostgreSQL, selective term, 20 000 documents / 50 000
  issues: `coalesce(documents.title, '')` sequential scan 13.3 ms → bitmap index
  scan 0.6 ms; `coalesce(issues.identifier, '')` 37.3 ms → 2.6 ms.
- Guard: `server/src/__tests__/task-search-trgm-index.myrmidon.test.ts` asserts
  every search index exists as a GIN index, that each emitted predicate is served
  by its index instead of a sequential scan, that dropping the expression index
  puts the statement back on a sequential scan (the assertions have teeth), and
  that company search returns the same hits with and without the expression
  indexes.
- `CREATE INDEX IF NOT EXISTS` (not CONCURRENTLY — the migration runner wraps
  every file in a transaction) on the medium-bucket tables `documents` and
  `issues`; an operator who wants to build it on a live board without the
  migration's brief lock uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS` with the
  same definition, and the idempotent statements then skip the finished work.

## changelog-ru

### Поиск по тексту: триграммные индексы теперь закрывают и выражения с coalesce (1.6.5 PERF-DIET-P)

- Оба пути поиска ищут по тексту через `ILIKE '%…%'`, и оба уже опирались на
  GIN-индексы pg_trgm: обычные поколочные — из вендорных миграций `0051`/`0079`
  (`issues(title)`, `issues(description)`, `issues(identifier)`,
  `issue_comments(body)`, `documents(title)`, `documents(latest_body)`), а запрос
  поиска задач сопоставляет эти колонки без обёрток и потому ими пользуется.
- У поиска по компании есть второе семейство условий, где колонка обёрнута в
  `coalesce`: `coalesce(title, '') ILIKE '%…%'` по `documents` и
  `coalesce(identifier, '') ILIKE '%…%'` по `issues`
  (`server/src/services/company-search.ts`, `company-artifacts.ts`). Выражение в
  обёртке не может воспользоваться поколочным индексом, поэтому планировщик
  читал `documents` целиком — таблицу, где лежит тяжёлая колонка `latest_body`, —
  и `issues` целиком.
- Миграция `packages/db/src/migrations/0321_search_coalesce_trgm_indexes.sql`
  добавляет по одному индексному выражению на каждую фактически отправляемую
  формы: `gin ((coalesce(col, '')) gin_trgm_ops)`. Она также повторяет
  `CREATE EXTENSION IF NOT EXISTS pg_trgm` (идемпотентно; расширение уже
  создано вендорской миграцией `0051`) — так файл самодостаточен. Аддитивная и
  индексная миграция: текст запросов, схема и поведение не меняются, семантика
  поиска остаётся прежней (NULL-колонка и пустая строка одинаково не совпадают,
  а условия стоят в положительных цепочках OR/AND).
- Замер на встроенном PostgreSQL, выборочный терм, 20 000 документов / 50 000
  задач: `coalesce(documents.title, '')` — последовательное чтение 13,3 мс →
  bitmap index scan 0,6 мс; `coalesce(issues.identifier, '')` — 37,3 мс → 2,6 мс.
- Сторож: `server/src/__tests__/task-search-trgm-index.myrmidon.test.ts`
  проверяет, что каждый индекс поиска существует и является GIN-индексом, что
  каждое отправляемое условие обслуживается своим индексом, а не последовательным
  чтением, что после удаления индексного выражения запрос снова уходит в
  последовательное чтение (то есть проверки действительно кусаются), и что поиск
  по компании возвращает те же попадания с индексами и без них.
- `CREATE INDEX IF NOT EXISTS` (не CONCURRENTLY — раннер миграций оборачивает
  каждый файл в транзакцию) по таблицам средней корзины `documents` и `issues`;
  оператору, который хочет построить индекс на боевой доске без краткой
  блокировки из миграции, нужен `CREATE INDEX CONCURRENTLY IF NOT EXISTS` с тем
  же определением — идемпотентные операторы миграции тогда пропускают уже
  построенные индексы.