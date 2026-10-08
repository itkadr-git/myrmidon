# Hybrid search index (CORPUS-2.0)

`createPostgresSearchIndex` implements the module's `SearchIndex` port on PostgreSQL with the
parameters the pilot measured (CORPUS-2.0 step 3): vector search over HNSW plus full-text
search, merged by reciprocal rank fusion.

## What the implementation needs from the database

- `vector` and `pg_trgm` extensions, and a `vector(1024)` column of L2-normalized embeddings.
  The width and the table/column names are options (`schema`), because a stand may run
  narrower vectors; the module default is 1024.
- An HNSW index on the embedding column (`m = 16`, `ef_construction = 64`), `vector_cosine_ops`.
  The index ships with the package's `corpus_*` migrations, not at query time.
- A `tsvector` column plus a `pg_trgm` GIN index for the full-text ranking, as the pilot
  required. The column is filled by the migration's trigger/generated definition.
- A `dataset` column on the chunks table: every query filters by company and dataset, so a
  search never crosses datasets.

## Clusters without pgvector

The package's migrations split the corpus objects in two on purpose: the full-text objects (the
generated `tsvector` column, the trigram GIN index) are always created, while the vector objects
(the `vector` extension, the `embedding` column, its HNSW index) are created only where pgvector is
available. On a cluster migrated without them, `search()` with an `embedding` fails with
`CorpusVectorSearchUnavailableError` — a module error that says which migration is missing and keeps
the driver error as `pgError` — instead of leaking an "undefined column" or "undefined object" from
the driver. A search without an `embedding` runs only the full-text leg and keeps working, so a
deployment without pgvector can still search by text. Fresh installations ship the extension — the
installer runs on the `pgvector/pgvector` image and enables `vector` before the board starts — and
the production cluster carries it too, so this path is for installs that are upgraded in place from
an older image; the guard turns a missing extension into a named error instead of a broken worker.

## Query shape

One `search()` call runs three statements inside one transaction:

1. `set local hnsw.ef_search = 64` — the pilot's recall/latency balance; configurable.
2. Vector ranking: `order by embedding <=> $1::vector` over the dataset's chunks, with
   `embedding` passed as a pgvector literal.
3. Full-text ranking: `ts_rank` over the same rows with `plainto_tsquery($5, $1)` and an
   `ilike '%…%'` trigram prefilter; `%` and `_` in the query text are escaped before they
   reach the pattern.

Both rankings take `kCandidates = 100` rows, and the fusion (`k0 = 60`) turns them into one
ranked list by rank, never by score: cosine distance and `ts_rank` are not comparable. Ties
on the fused score are broken by the vector rank, then the full-text rank, then the id, so
the order is stable. Each hit carries `score`, `chunk`, `document`, and `fusion` (both ranks);
hits whose document row is missing are dropped instead of returned half-filled.

## Seam

The implementation talks to the database through the `SqlExecutor` interface
(`query` + `withTransaction`) instead of importing a driver, so the package stays independent
of how the product opens its connections and the search path can be unit-tested with a
recording executor. `createDrizzleExecutor`-style adapters over the product's client belong
to the wiring, not to this package.

## Tests

- [hybrid-search-index.myrmidon.test.ts](hybrid-search-index.myrmidon.test.ts) — unit tests
  with a recording `SqlExecutor`: statements, bound values, fusion order, escaping,
  validation.
- [hybrid-search-index.integration.myrmidon.test.ts](hybrid-search-index.integration.myrmidon.test.ts)
  — runs against a database that allows `CREATE EXTENSION`, taken from the first source that works:
  the external stand named by `CORPUS_TEST_PGVECTOR_DSN`, or else the embedded PostgreSQL 18 test
  cluster of `@paperclipai/db` with pgvector staged into it by [../test-pgvector.ts](../test-pgvector.ts)
  (the same pair the store/queue suite uses). It creates the probe extensions, tables and indexes,
  seeds a synthetic corpus, and asserts the top-k contract, the dataset filter and recall@5 of hybrid
  retrieval on exact and noisy query vectors. It also measures p95 latency — `CORPUS_SEARCH_PERF_CHUNKS=100000`
  scales the synthetic set to the acceptance size (10^5 chunks) — and prints the `EXPLAIN (ANALYZE,
  BUFFERS)` plan of both rankings as the product emits them, for the PR report. With neither source
  available the whole suite skips with a printed reason, so a host that cannot stage pgvector (no
  `ar`/`tar`, no network, foreign platform) stays green while the vector path is exercised where it
  can be. The suite needs `postgres` as a devDependency (the driver of the stand client,
  `packages/db` uses the same one).