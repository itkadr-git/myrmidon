import type { SearchIndexSchema } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

/**
 * Probe schema of the hybrid search integration suite.
 *
 * The suite never writes through the product table names, so it creates its own pair of tables. The
 * columns of those tables have to mirror every column the search SQL reads: a probe table that has
 * drifted from the query surface does not skip, it fails — and the drift can only be seen on a host
 * that actually has PostgreSQL. The DDL and the column lists therefore live here, next to the search
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
    `;
}