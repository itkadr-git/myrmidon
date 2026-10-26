# @myrmidon/corpus

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

Tables (all additive, migration `0390_corpus_module` in `@myrmidon/db`):

| Table | Purpose |
| --- | --- |
| `corpus_datasets` | Corpora: name, embedding model, dimensions |
| `corpus_documents` | Documents with parse status (`queued/parsing/embedding/ready/failed`) |
| `corpus_chunks` | Chunks: `content`, `embedding vector(1024)` (HNSW m=16, ef_construction=64), generated `tsvector` FTS column (GIN), `content` trigram GIN index |
| `corpus_parse_jobs` | Parse queue: idempotent on `(document_id, parser_version)`, retries with backoff |
| `corpus_settings` | Per-company module settings (feature flag, default URLs, models) |

All queries are company-scoped: every read/write takes `companyId`.

## RAGFlow corpus import

The `scripts/myrmidon/ragflow-corpus-import.ts` CLI copies already-parsed
RAGFlow dataset, document, and chunk records into `corpus_*`; it calls only
RAGFlow's read endpoints and never re-runs parsing. Chunk text and positions are
retained, with stable IDs and conflict-safe upserts so a failed run can resume.
Chunks without a matching stored vector are embedded through LiteLLM in
configurable batches and parallel requests. Progress and the final elapsed
milliseconds are JSON lines on stdout.

Run it with `pnpm --filter @myrmidon/server corpus:import:ragflow` after
setting `RAGFLOW_BASE_URL`, `RAGFLOW_API_KEY`, `DATABASE_URL`,
`CORPUS_COMPANY_ID`, `LITELLM_BASE_URL`, and `LITELLM_API_KEY`. Select the pilot
with `CORPUS_EMBEDDING_MODEL` (default `text-embedding-v4`); corpus
storage currently requires 1024 dimensions. The acceptance guard defaults to
12 datasets, 2,185 documents, and 256,498 chunks within 1%; override these only
for an intentionally different source corpus. `CORPUS_IMPORT_BATCH_SIZE` and
`CORPUS_IMPORT_CONCURRENCY` tune embedding batch size/concurrency.

The importer stores the authenticated RAGFlow document-record API URL as
`source_uri`; it does not retrieve or copy original file bytes, and it does not
invent a content hash. The fixture test covers chunk/position transfer,
idempotent resume, concurrent embeddings, pagination, count mismatches, and
vector checks.

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
pnpm --filter @myrmidon/corpus exec vitest run
```

Store/queue tests boot an embedded PostgreSQL 18 (`embedded-postgres`, the
same harness as `@myrmidon/db` tests) and apply the real migration files;
on hosts where embedded Postgres is unsupported they skip with a warning.

## License

MIT.
