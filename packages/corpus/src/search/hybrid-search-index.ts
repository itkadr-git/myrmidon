// myrmidon(CORPUS-2.0): the PostgreSQL implementation of the hybrid search index.
//
// One search runs two rankings over `corpus_chunks`, both filtered by company and dataset:
//   * vector: `embedding <=> $query` (cosine, HNSW index), with `hnsw.ef_search` set for the
//     transaction, because the pilot measured its recall with ef_search = 64;
//   * full text: `content_tsv @@ plainto_tsquery(...)` (GIN) plus an `ILIKE` fallback that the
//     trigram GIN index serves, ordered by `ts_rank` and then by trigram similarity.
// The two rankings are merged with RRF (k0 = 60, k_candidates = 100) and the top-k hits are
// returned with their chunk and document rows.
//
// The module talks to the database through `SqlExecutor` instead of a driver, so the query
// shape is testable without a database and the module does not pick a driver for the product.

import { reciprocalRankFusion, type FusionParameters, DEFAULT_FUSION_PARAMETERS } from "./rrf.js";
import {
  DEFAULT_EF_SEARCH,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type CorpusSearchChunk,
  type CorpusSearchDocument,
  type CorpusSearchHit,
  type CorpusSearchIndex,
  type CorpusSearchRequest,
} from "./types.js";
import { assertEmbeddingVector, toPgVectorLiteral } from "./vector.js";

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
  fullTextColumn: "content_tsv",
  embeddingColumn: "embedding",
};

export interface PostgresSearchIndexOptions {
  readonly sql: SqlExecutor;
  readonly schema?: SearchIndexSchema;
  readonly fusion?: FusionParameters;
  /** `hnsw.ef_search` of the vector ranking; the pilot value is 64. */
  readonly efSearch?: number;
  /** Text search configuration of `plainto_tsquery`, e.g. `russian` or `simple`. */
  readonly ftsLanguage?: string;
}

interface ChunkRow extends Record<string, unknown> {
  id: string;
  company_id: string;
  dataset_id: string;
  document_id: string;
  ordinal: number;
  content: string;
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

export function createPostgresSearchIndex(options: PostgresSearchIndexOptions): CorpusSearchIndex {
  const schema = options.schema ?? DEFAULT_SEARCH_INDEX_SCHEMA;
  const fusion = options.fusion ?? DEFAULT_FUSION_PARAMETERS;
  const efSearch = options.efSearch ?? DEFAULT_EF_SEARCH;
  if (!Number.isInteger(efSearch) || efSearch < 1) throw new RangeError("ef_search must be a positive integer");
  const language = sqlLanguage(options.ftsLanguage ?? "russian");

  const chunks = sqlIdentifier(schema.chunksTable, "chunks table");
  const documents = sqlIdentifier(schema.documentsTable, "documents table");
  const content = sqlIdentifier(schema.contentColumn, "content column");
  const fullText = sqlIdentifier(schema.fullTextColumn, "full text column");
  const embedding = sqlIdentifier(schema.embeddingColumn, "embedding column");

  const vectorSql = [
    `select c.id, c.company_id, c.dataset_id, c.document_id, c.ordinal, c.${content} as content,`,
    `       1 - (c.${embedding} <=> $1::vector) as score`,
    `  from ${chunks} c`,
    ` where c.company_id = $2::uuid`,
    `   and c.dataset_id = $3::uuid`,
    `   and c.${embedding} is not null`,
    ` order by c.${embedding} <=> $1::vector`,
    ` limit $4`,
  ].join("\n");

  const fullTextSql = [
    `select c.id, c.company_id, c.dataset_id, c.document_id, c.ordinal, c.${content} as content,`,
    `       ts_rank(c.${fullText}, plainto_tsquery($5::regconfig, $1)) as score`,
    `  from ${chunks} c`,
    ` where c.company_id = $2::uuid`,
    `   and c.dataset_id = $3::uuid`,
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
    async search(request: CorpusSearchRequest): Promise<CorpusSearchHit[]> {
      const limit = clampLimit(request.limit);
      const embeddingLiteral = toPgVectorLiteral(
        assertEmbeddingVector(request.embedding),
      );
      const kCandidates = Math.max(limit, fusion.kCandidates);
      const likePattern = `%${escapeLikePattern(request.queryText)}%`;

      const { vectorRows, fullTextRows } = await options.sql.withTransaction(async (transaction) => {
        await transaction.query(efSearchSql);
        const vectorRows = await transaction.query<ChunkRow>(vectorSql, [
          embeddingLiteral,
          request.companyId,
          request.datasetId,
          kCandidates,
        ]);
        const fullTextRows = await transaction.query<ChunkRow>(fullTextSql, [
          request.queryText,
          request.companyId,
          request.datasetId,
          likePattern,
          language,
          kCandidates,
        ]);
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
        ? await options.sql.query<DocumentRow>(documentsSql, [request.companyId, documentIds])
        : [];
      const documentsById = new Map(documentRows.map((row) => [row.id, row]));

      const hits: CorpusSearchHit[] = [];
      for (const candidate of fused) {
        const row = chunksById.get(candidate.id);
        if (!row) continue;
        const document = documentsById.get(row.document_id);
        if (!document) continue;
        hits.push({
          score: candidate.score,
          chunk: toChunk(row),
          document: toDocument(document),
          fusion: { vectorRank: candidate.vectorRank, fullTextRank: candidate.fullTextRank },
        });
      }
      return hits;
    },
  };
}

function toChunk(row: ChunkRow): CorpusSearchChunk {
  return {
    id: row.id,
    companyId: row.company_id,
    datasetId: row.dataset_id,
    documentId: row.document_id,
    ordinal: Number(row.ordinal),
    content: row.content,
  };
}

function toDocument(row: DocumentRow): CorpusSearchDocument {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    title: row.title,
    sourceUri: row.source_uri,
  };
}