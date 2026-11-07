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

One `search()` call runs these statements inside one transaction:

1. `set local hnsw.ef_search = 64` — the pilot's recall/latency balance; configurable.
2. Vector ranking. The HNSW index knows the company, not the dataset (a chunk has no dataset column,
   the dataset lives on `corpus_documents`), and the dataset and `ready` filters run after the index
   scan. Without the iterative scan the scan stops after `ef_search = 64` rows, so the filter leaves
   whatever of them belongs to the dataset: on production about half of the 100 candidates. The
   ranking therefore reads the pgvector version once per index and then, on pgvector 0.8 and later:
   - `set local hnsw.iterative_scan = relaxed_order` with `hnsw.max_scan_tuples = 100000` (the
     `maxScanTuples` option; pgvector's own limit is 20 000, which a question far from a dataset of
     13 % of the corpus reached with 47 to 67 of the 100 candidates), and the plain
     `order by embedding <=> $1::vector limit k` statement: an index scan that the planner picks keeps
     going until `k` rows have passed the filters. The relaxed scan returns the rows slightly out of
     order, so the rows are sorted by score before the fusion. A dataset that holds too few chunks
     for `k` returns what it has;
   - a dataset of at most `exactSetMaxChunks` embedded chunks (10 000 by default; `0` switches the
     routing off) is ranked exactly instead: the same statement with `order by (embedding <=> $1) + 0`,
     which keeps the planner off the index and reads the chunks of the requested datasets. That takes
     milliseconds for a small dataset, while the index scan, cut by company only, has to walk far to
     find a few chunks of it. The size comes from a bounded probe (`count(*)` with `limit
     exactSetMaxChunks + 1`);
   - a search without a dataset goes through the iterative scan with no probe.

   On pgvector before 0.8 (no `hnsw.iterative_scan`) the ranking is the plain statement alone, with no
   probe. The version is read from `pg_extension` and not tried with a `SET`, because a refused `SET`
   aborts the transaction and the product's driver rethrows it at the end of the transaction even when
   the caller caught it.
3. Full-text ranking: `ts_rank` over the same rows with `plainto_tsquery($5, $1)`. A query text of
   at most `ilikeMaxLength` characters (16 by default) also gets an `ilike '%…%'` trigram match;
   `%` and `_` in the query text are escaped before they reach the pattern. A longer text is matched
   by the `tsvector` alone: the trigram index reads one posting list per trigram of the pattern, so
   the cost of the match grows with the length of the text (a 40-character question read from 150 ms
   to 1.2 s on a cold index in production), while a long question is almost never a verbatim
   substring of a chunk.

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
  cluster of `@myrmidon/db` with pgvector staged into it by [../test-pgvector.ts](../test-pgvector.ts)
  (the same pair the store/queue suite uses). It creates the probe extensions, tables and indexes,
  seeds a synthetic corpus, and asserts the top-k contract, the dataset filter and recall@5 of hybrid
  retrieval on exact and noisy query vectors. It also measures p95 latency — `CORPUS_SEARCH_PERF_CHUNKS=100000`
  scales the synthetic set to the acceptance size (10^5 chunks) — and prints the `EXPLAIN (ANALYZE,
  BUFFERS)` plan of both rankings as the product emits them, for the PR report. With neither source
  available the whole suite skips with a printed reason, so a host that cannot stage pgvector (no
  `ar`/`tar`, no network, foreign platform) stays green while the vector path is exercised where it
  can be. The suite needs `postgres` as a devDependency (the driver of the stand client,
  `packages/db` uses the same one). The tables it creates are described by
  [probe-schema.ts](probe-schema.ts), whose `content_tsv` is written explicitly (the product column
  is generated from `content`) and whose `status` carries `ready` — the column the search scope
  filters on.
- [probe-schema.myrmidon.test.ts](probe-schema.myrmidon.test.ts) — a database-free guard for the
  pair above. The integration suite can only fail where PostgreSQL exists, so a probe table that
  drifts from the query surface would first show up as a red CI lane; this check takes the SQL the
  index really emits (a recording executor) and asserts every `c.<column>` / `d.<column>` reference
  exists in the probe schema, that the DDL creates each declared column, and that the seeded text
  and the query share one text search configuration.