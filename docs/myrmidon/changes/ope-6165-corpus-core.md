---
divergence-section: Track 2 — knowledge corpus
settings-section: Track 2 — knowledge corpus
---

## changelog-en

### Corpus knowledge module core: ports, domain, migrations, PostgreSQL store/queue (CORPUS-A)

- `packages/corpus` (new, MIT) — the knowledge corpus module core: pure domain
  model and company-scoped ports (CorpusStore, SearchIndex, WorkQueue,
  BlobStore, DocumentParser, Embedder) plus PostgreSQL implementations of the
  store, the parse-job queue (idempotent on document+parser version, retries
  with backoff) and per-company settings, and a local-directory blob store.
- `packages/db` — additive migration `0309_corpus_module`: `corpus_datasets`,
  `corpus_documents`, `corpus_chunks` (pgvector `vector(1024)` with HNSW
  m=16/ef_construction=64, generated `tsvector` FTS with GIN, trigram GIN),
  `corpus_parse_jobs`, `corpus_settings`; requires `vector` and `pg_trgm`
  extensions (created by the migration itself).
- Tests: store/queue lifecycle on embedded PostgreSQL 18 with pgvector
  (queued → parsing → embedding → ready, enqueue idempotency, failed-job
  re-queue), domain invariant tests, local blob store tests.

## changelog-ru

### Ядро модуля корпуса знаний: порты, домен, миграции, PostgreSQL store/очередь (CORPUS-A)

- `packages/corpus` (новый, MIT) — ядро модуля корпуса знаний: чистая доменная
  модель и порты с областью компании (CorpusStore, SearchIndex, WorkQueue,
  BlobStore, DocumentParser, Embedder) плюс реализации на PostgreSQL: store,
  очередь разбора (идемпотентность по документ+версия парсера, повторы с
  backoff), настройки компании, а также blob-хранилище на локальном каталоге.
- `packages/db` — аддитивная миграция `0309_corpus_module`: `corpus_datasets`,
  `corpus_documents`, `corpus_chunks` (pgvector `vector(1024)` с HNSW
  m=16/ef_construction=64, генерируемый `tsvector` FTS с GIN, триграммный
  GIN), `corpus_parse_jobs`, `corpus_settings`; требует расширения `vector` и
  `pg_trgm` (миграция создаёт их сама).
- Тесты: жизненный цикл store/очереди на встроенном PostgreSQL 18 с pgvector
  (queued → parsing → embedding → ready, идемпотентность постановки в очередь,
  повтор failed-джобы), тесты инвариантов домена, тесты blob-хранилища.
