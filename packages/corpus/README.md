# @paperclipai/corpus

Knowledge corpus module: the retrieval core behind the product's own RAG
(replaces the external RAGFlow dependency). The package is self-contained:
it imports nothing RAGFlow-related and builds without any external service.

## Layout

- `src/domain.ts` — pure domain model: datasets, documents, chunks, the parse
  lifecycle (`queued -> parsing -> embedding -> ready | failed`) and its
  invariants (legal transitions, embedding dimensionality, retry backoff).
  No database imports.
- `src/ports.ts` — interfaces only:
  - `CorpusStore` — datasets, documents, chunks;
  - `SearchIndex` — hybrid vector + full-text retrieval (implemented by a
    follow-up part on top of these ports);
  - `WorkQueue` — parse-job scheduling with idempotent enqueue;
  - `BlobStore` — raw document bytes;
  - `DocumentParser` — HTTP client port of the external parse service;
  - `Embedder` — OpenAI-compatible embeddings endpoint (the company gateway;
    default model `dashscope-text-embedding-v4`, 1024 dimensions).
- `src/postgres/` — PostgreSQL implementations of `CorpusStore`, `WorkQueue`
  and the module settings store. This is the only layer with SQL dialect
  operators (`vector`, `tsvector`, `FOR UPDATE SKIP LOCKED`, ...).
- `src/local/` — `LocalBlobStore`, a `BlobStore` on a local directory.

## Database

Tables (all additive, migration `0309_corpus_module` in `@paperclipai/db`):

| Table | Purpose |
| --- | --- |
| `corpus_datasets` | Corpora: name, embedding model, dimensions |
| `corpus_documents` | Documents with parse status (`queued/parsing/embedding/ready/failed`) |
| `corpus_chunks` | Chunks: `content`, `embedding vector(1024)` (HNSW m=16, ef_construction=64), generated `tsvector` FTS column (GIN), `content` trigram GIN index |
| `corpus_parse_jobs` | Parse queue: idempotent on `(document_id, parser_version)`, retries with backoff |
| `corpus_settings` | Per-company module settings (feature flag, default URLs, models) |

All queries are company-scoped: every read/write takes `companyId`.

## Parse pipeline

1. `CorpusStore.createDocument` — document row in `queued`.
2. `WorkQueue.enqueue` — parse job; idempotent on
   `(document_id, parser_version)`, a failed job is re-armed by re-enqueueing.
3. A worker claims jobs (`claimNext`, atomic `FOR UPDATE SKIP LOCKED`), drives
   the document through `parsing` (DocumentParser) and `embedding` (Embedder),
   stores chunks via `replaceDocumentChunks` and finishes at `ready`.
4. Failures retry with backoff (`parseJobRetryDelayMs`); when attempts are
   exhausted the job is `failed` and the document goes to `failed`.

## Tests

```sh
pnpm --filter @paperclipai/corpus exec vitest run
```

Store/queue tests boot an embedded PostgreSQL 18 (`embedded-postgres`, the
same harness as `@paperclipai/db` tests) and apply the real migration files;
on hosts where embedded Postgres is unsupported they skip with a warning.

## License

MIT.
