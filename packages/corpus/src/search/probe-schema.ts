import type { SearchIndexSchema } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

/**
 * Probe schema of the hybrid search integration suite.
 *
 * The suite never writes through the product table names, so it creates its own pair of tables. The
 * columns of those tables have to mirror every column the search SQL reads: a probe table that has
 * drifted from the query surface does not skip, it fails — and the drift can only be seen on a host
 * that actually has PostgreSQL. The indexes have to mirror the migration's as well, for the same
 * reason one step further out: the plan a stand produces is the plan it measures. The DDL and the
 * column and index lists therefore live here, next to the search
 * package, so `probe-schema.test.ts` can assert them against the real SQL on a host without a
 * database (the same arrangement as `../test-pgvector.ts` of the store/queue suite).
 */

/** Text search configuration of the probe `tsvector` writes and of `plainto_tsquery`. */
export const PROBE_FTS_LANGUAGE = "english";

/** Columns of the probe chunks table read by the search SQL under its `c` alias. */
export const PROBE_CHUNK_COLUMNS = [
  "id",
  "company_id",
  "dataset_id",
  "document_id",
  "chunk_index",
  "content",
  "content_tsv",
  "embedding",
  "token_count",
  "metadata",
] as const;

/** Columns of the probe documents table read by the search SQL under its `d` alias. */
export const PROBE_DOCUMENT_COLUMNS = [
  "id",
  "company_id",
  "dataset_id",
  "status",
  "title",
  "source_uri",
] as const;

export const PROBE_SEARCH_INDEX_SCHEMA: SearchIndexSchema = {
  chunksTable: "corpus_search_probe_chunks",
  documentsTable: "corpus_search_probe_documents",
  contentColumn: "content",
  fullTextColumn: "content_tsv",
  embeddingColumn: "embedding",
};

/**
 * Btree indexes of the probe tables, mirroring the ones the corpus migration creates on the same
 * columns (`packages/db/src/migrations/0309_corpus_module.sql`).
 *
 * They are not decoration. The search SQL joins chunks to documents by `document_id` and narrows
 * documents by `(dataset_id, status)`, and a stand without those indexes does not measure the same
 * query the product runs: on CI the planner answered with a nested loop that scanned every chunk per
 * document and eliminated four million join pairs (`Rows Removed by Join Filter: 4000000`,
 * 789 ms over a 2000-chunk stand), where production, which has the indexes, joins by index. A stand
 * that is cheaper or dearer than production is a stand whose timing means nothing.
 */
export const PROBE_INDEXES = [
  { table: PROBE_SEARCH_INDEX_SCHEMA.chunksTable, name: "corpus_search_probe_chunks_document_idx", columns: ["document_id"] },
  {
    table: PROBE_SEARCH_INDEX_SCHEMA.chunksTable,
    name: "corpus_search_probe_chunks_company_document_idx",
    columns: ["company_id", "document_id"],
  },
  {
    table: PROBE_SEARCH_INDEX_SCHEMA.documentsTable,
    name: "corpus_search_probe_documents_dataset_status_idx",
    columns: ["dataset_id", "status"],
  },
  {
    table: PROBE_SEARCH_INDEX_SCHEMA.documentsTable,
    name: "corpus_search_probe_documents_company_status_idx",
    columns: ["company_id", "status"],
  },
] as const;

/**
 * The `tsvector` write of the probe suite, built from the same language the index passes to
 * `plainto_tsquery`, so the seeded text and the query cannot drift apart.
 */
export function probeContentTsVector(placeholder: string): string {
  return `to_tsvector('${PROBE_FTS_LANGUAGE}', ${placeholder}::text)`;
}

/**
 * DDL of the probe tables, dropped first so a reusable stand is left clean.
 *
 * Two columns deserve a note. `content_tsv` is a plain column the suite writes explicitly, while the
 * product table has it generated from `content` — the suite must be able to seed text and vector
 * independently. `status` is the column the search scope filters on (`d.status = 'ready'`), so a
 * seeded document has to carry `ready`; without it every search would fail on an unknown column.
 */
export function probeSchemaSql(): string {
  const { chunksTable, documentsTable } = PROBE_SEARCH_INDEX_SCHEMA;
  return `
      drop table if exists ${chunksTable} cascade;
      drop table if exists ${documentsTable} cascade;
      create table ${documentsTable} (
        id uuid primary key,
        company_id uuid not null,
        dataset_id uuid not null,
        status text not null default 'ready',
        title text,
        source_uri text
      );
      create table ${chunksTable} (
        id uuid primary key,
        company_id uuid not null,
        dataset_id uuid not null,
        document_id uuid not null,
        chunk_index integer not null,
        content text not null,
        content_tsv tsvector,
        embedding vector(${CORPUS_EMBEDDING_DIMENSIONS}),
        token_count integer,
        metadata jsonb not null default '{}'::jsonb
      );
      create index ${chunksTable}_embedding_hnsw on ${chunksTable}
        using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
      create index ${chunksTable}_content_tsv_gin on ${chunksTable} using gin (content_tsv);
      create index ${chunksTable}_content_trgm_gin on ${chunksTable} using gin (content gin_trgm_ops);
${PROBE_INDEXES.map(
  (index) => `      create index ${index.name} on ${index.table} using btree (${index.columns.join(", ")});`,
).join("\n")}
    `;
}