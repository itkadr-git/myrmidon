// myrmidon(CORPUS-2.0): the PostgreSQL implementation of the hybrid SearchIndex port.
//
// One search runs up to two rankings over `corpus_chunks`, both scoped by company and by dataset
// (the dataset lives on `corpus_documents`, and only chunks of `ready` documents are searchable):
//   * vector: `embedding <=> $query` (cosine over the HNSW index), with `hnsw.ef_search` set for
//     the transaction, because the pilot measured its recall with ef_search = 64;
//   * full text: `fts @@ plainto_tsquery(...)` (the GIN index over the generated tsvector) plus an
//     `ILIKE` fallback that the trigram GIN index serves.
// The two rankings are merged with RRF (k0 = 60, k_candidates = 100) and the top-k hits are
// returned with their chunk and document rows.
//
// The module talks to the database through `SqlExecutor` instead of a driver, so the query shape is
// testable without a database and the module does not pick a driver for the product.

import type { CorpusSearchQuery, SearchIndex } from "../ports.js";
import { reciprocalRankFusion, type FusionParameters, DEFAULT_FUSION_PARAMETERS } from "./rrf.js";
import {
  DEFAULT_EF_SEARCH,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type CorpusSearchChunkRef,
  type CorpusSearchDocumentRef,
  type CorpusSearchHitDetail,
} from "./types.js";
import { assertEmbeddingVector, toPgVectorLiteral } from "./vector.js";

/**
 * The index as this implementation returns it: every method of the `SearchIndex` port, with hits
 * that also carry the chunk and document rows they came from.
 */
export interface PostgresSearchIndex extends SearchIndex {
  search(query: CorpusSearchQuery): Promise<CorpusSearchHitDetail[]>;
}

export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row[]>;
  /** Runs `run` inside one transaction, so `SET LOCAL` stays on the connection it belongs to. */
  withTransaction<T>(run: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Table and column names the queries read. The defaults are the corpus schema of the module. */
export interface SearchIndexSchema {
  readonly chunksTable: string;
  readonly documentsTable: string;
  readonly contentColumn: string;
  readonly fullTextColumn: string;
  readonly embeddingColumn: string;
}

export const DEFAULT_SEARCH_INDEX_SCHEMA: SearchIndexSchema = {
  chunksTable: "corpus_chunks",
  documentsTable: "corpus_documents",
  contentColumn: "content",
  // The generated tsvector column of the corpus migration (generated from `content`).
  fullTextColumn: "fts",
  embeddingColumn: "embedding",
};

export interface PostgresSearchIndexOptions {
  readonly sql: SqlExecutor;
  readonly schema?: SearchIndexSchema;
  readonly fusion?: FusionParameters;
  /** `hnsw.ef_search` of the vector ranking; the pilot value is 64. */
  readonly efSearch?: number;
  /**
   * Text search configuration of `plainto_tsquery`. It must be the configuration the generated
   * `fts` column was built with — the corpus migration uses `english`.
   */
  readonly ftsLanguage?: string;
}

interface ChunkRow extends Record<string, unknown> {
  id: string;
  company_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  metadata: Record<string, unknown> | null;
}

interface DocumentRow extends Record<string, unknown> {
  id: string;
  dataset_id: string;
  title: string | null;
  source_uri: string | null;
}

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

function sqlIdentifier(name: string, what: string): string {
  if (!IDENTIFIER_PATTERN.test(name)) throw new RangeError(`${what} is not a valid SQL identifier: ${name}`);
  return `"${name}"`;
}

function sqlLanguage(language: string): string {
  if (!IDENTIFIER_PATTERN.test(language)) throw new RangeError(`invalid full text language: ${language}`);
  return language;
}

/** Escapes the wildcards of a `LIKE`/`ILIKE` pattern so user text cannot widen the match. */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("search limit must be a positive integer");
  return Math.min(limit, MAX_SEARCH_LIMIT);
}

/** A query text of whitespace only cannot rank anything, so the full-text leg is skipped. */
function hasText(text: string | undefined): boolean {
  return typeof text === "string" && text.trim().length > 0;
}

export function createPostgresSearchIndex(options: PostgresSearchIndexOptions): PostgresSearchIndex {
  const schema = options.schema ?? DEFAULT_SEARCH_INDEX_SCHEMA;
  const fusion = options.fusion ?? DEFAULT_FUSION_PARAMETERS;
  const efSearch = options.efSearch ?? DEFAULT_EF_SEARCH;
  if (!Number.isInteger(efSearch) || efSearch < 1) throw new RangeError("ef_search must be a positive integer");
  const language = sqlLanguage(options.ftsLanguage ?? "english");

  const chunks = sqlIdentifier(schema.chunksTable, "chunks table");
  const documents = sqlIdentifier(schema.documentsTable, "documents table");
  const content = sqlIdentifier(schema.contentColumn, "content column");
  const fullText = sqlIdentifier(schema.fullTextColumn, "full text column");
  const embedding = sqlIdentifier(schema.embeddingColumn, "embedding column");

  // `$3` is the optional dataset: `$3::uuid is null` keeps one statement for both a dataset-scoped
  // and a company-wide search.
  const scope = [
    `  from ${chunks} c`,
    `  join ${documents} d on d.id = c.document_id and d.company_id = c.company_id`,
    ` where c.company_id = $2::uuid`,
    `   and ($3::uuid is null or d.dataset_id = $3::uuid)`,
    `   and d.status = 'ready'`,
  ].join("\n");

  const chunkColumns = [
    `       c.id, c.company_id, c.document_id, c.chunk_index, c.${content} as content,`,
    `       c.token_count, c.metadata,`,
  ].join("\n");

  const vectorSql = [
    `select`,
    chunkColumns,
    `       1 - (c.${embedding} <=> $1::vector) as score`,
    scope,
    `   and c.${embedding} is not null`,
    ` order by c.${embedding} <=> $1::vector`,
    ` limit $4`,
  ].join("\n");

  const fullTextSql = [
    `select`,
    chunkColumns,
    `       ts_rank(c.${fullText}, plainto_tsquery($5::regconfig, $1)) as score`,
    scope,
    `   and (c.${fullText} @@ plainto_tsquery($5::regconfig, $1) or c.${content} ilike $4)`,
    ` order by ts_rank(c.${fullText}, plainto_tsquery($5::regconfig, $1)) desc,`,
    `          similarity(c.${content}, $1) desc`,
    ` limit $6`,
  ].join("\n");

  const documentsSql = [
    `select d.id, d.dataset_id, d.title, d.source_uri`,
    `  from ${documents} d`,
    ` where d.company_id = $1::uuid`,
    `   and d.id::text = any($2::text[])`,
  ].join("\n");

  const efSearchSql = `set local hnsw.ef_search = ${efSearch}`;

  return {
    async search(query: CorpusSearchQuery) {
      const limit = clampLimit(query.limit);
      const datasetId = query.datasetId ?? null;
      const hasEmbedding = query.embedding !== undefined;
      const useFullText = hasText(query.text);
      if (!hasEmbedding && !useFullText) return [];

      const kCandidates = Math.max(limit, fusion.kCandidates);
      const likePattern = `%${escapeLikePattern(useFullText ? query.text.trim() : "")}%`;
      const embeddingLiteral = hasEmbedding
        ? toPgVectorLiteral(assertEmbeddingVector(query.embedding ?? []))
        : null;

      const { vectorRows, fullTextRows } = await options.sql.withTransaction(async (transaction) => {
        let vectorRows: ChunkRow[] = [];
        let fullTextRows: ChunkRow[] = [];
        if (embeddingLiteral !== null) {
          await transaction.query(efSearchSql);
          vectorRows = await transaction.query<ChunkRow>(vectorSql, [
            embeddingLiteral,
            query.companyId,
            datasetId,
            kCandidates,
          ]);
        }
        if (useFullText) {
          fullTextRows = await transaction.query<ChunkRow>(fullTextSql, [
            query.text.trim(),
            query.companyId,
            datasetId,
            likePattern,
            language,
            kCandidates,
          ]);
        }
        return { vectorRows, fullTextRows };
      });

      const fused = reciprocalRankFusion(
        vectorRows.map((row) => row.id),
        fullTextRows.map((row) => row.id),
        fusion,
      ).slice(0, limit);
      if (fused.length === 0) return [];

      const chunksById = new Map<string, ChunkRow>();
      for (const row of vectorRows) chunksById.set(row.id, row);
      for (const row of fullTextRows) {
        if (!chunksById.has(row.id)) chunksById.set(row.id, row);
      }

      const documentIds = [...new Set([...chunksById.values()].map((row) => row.document_id))];
      const documentRows = documentIds.length
        ? await options.sql.query<DocumentRow>(documentsSql, [query.companyId, documentIds])
        : [];
      const documentsById = new Map(documentRows.map((row) => [row.id, row]));

      const hits: CorpusSearchHitDetail[] = [];
      for (const candidate of fused) {
        const row = chunksById.get(candidate.id);
        if (!row) continue;
        const document = documentsById.get(row.document_id);
        if (!document) continue;
        hits.push({
          chunkId: row.id,
          documentId: row.document_id,
          datasetId: document.dataset_id,
          content: row.content,
          score: candidate.score,
          metadata: row.metadata ?? {},
          chunk: toChunkRef(row, document.dataset_id),
          document: toDocumentRef(document),
          fusion: { vectorRank: candidate.vectorRank, fullTextRank: candidate.fullTextRank },
        });
      }
      return hits;
    },

    /**
     * Chunks are rows, not a side index: `corpus_chunks` cascades on document delete and the
     * generated tsvector and the HNSW structure follow the rows, so there is nothing to invalidate.
     */
    async removeDocument(): Promise<void> {},
  };
}

function toChunkRef(row: ChunkRow, datasetId: string): CorpusSearchChunkRef {
  return {
    id: row.id,
    companyId: row.company_id,
    datasetId,
    documentId: row.document_id,
    chunkIndex: Number(row.chunk_index),
    content: row.content,
    tokenCount: row.token_count === null ? null : Number(row.token_count),
    metadata: row.metadata ?? {},
  };
}

function toDocumentRef(row: DocumentRow): CorpusSearchDocumentRef {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    title: row.title,
    sourceUri: row.source_uri,
  };
}