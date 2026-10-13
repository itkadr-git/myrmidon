// myrmidon(CORPUS-A): PostgreSQL CorpusStore. This file is part of the store
// layer — the only place in @paperclipai/corpus where drizzle/Postgres
// specifics may appear. Everything it returns is a plain domain value.
import { and, desc, eq, sql } from "drizzle-orm";
import {
  corpusChunks,
  corpusDatasets,
  corpusDocuments,
} from "@paperclipai/db";
import {
  CORPUS_DEFAULT_EMBEDDING_MODEL,
  assertDocumentStatusTransition,
  type CorpusChunk,
  type CorpusDataset,
  type CorpusDocument,
  type CorpusParseStatus,
} from "../domain.js";
import type {
  CorpusStore,
  CreateCorpusDatasetInput,
  CreateCorpusDocumentInput,
  CorpusDocumentListFilter,
  ReplaceCorpusChunksInput,
} from "../ports.js";
import type { CorpusDb } from "./types.js";

type DatasetRow = typeof corpusDatasets.$inferSelect;
type DocumentRow = typeof corpusDocuments.$inferSelect;
type ChunkRow = typeof corpusChunks.$inferSelect;

function toDataset(row: DatasetRow): CorpusDataset {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    embeddingModel: row.embeddingModel,
    embeddingDimensions: row.embeddingDimensions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDocument(row: DocumentRow): CorpusDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    datasetId: row.datasetId,
    title: row.title,
    sourceUri: row.sourceUri,
    blobKey: row.blobKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    status: row.status as CorpusParseStatus,
    parseError: row.parseError,
    parserVersion: row.parserVersion,
    contentHash: row.contentHash,
    parsedAt: row.parsedAt,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toChunk(row: ChunkRow): CorpusChunk {
  return {
    id: row.id,
    companyId: row.companyId,
    documentId: row.documentId,
    chunkIndex: row.chunkIndex,
    content: row.content,
    embedding: row.embedding ?? null,
    tokenCount: row.tokenCount,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

export class PostgresCorpusStore implements CorpusStore {
  constructor(private readonly db: CorpusDb) {}

  async createDataset(input: CreateCorpusDatasetInput): Promise<CorpusDataset> {
    const rows = await this.db
      .insert(corpusDatasets)
      .values({
        companyId: input.companyId,
        name: input.name,
        description: input.description ?? null,
        embeddingModel: input.embeddingModel ?? CORPUS_DEFAULT_EMBEDDING_MODEL,
      })
      .returning();
    return toDataset(rows[0]!);
  }

  async getDataset(companyId: string, datasetId: string): Promise<CorpusDataset | null> {
    const rows = await this.db
      .select()
      .from(corpusDatasets)
      .where(and(eq(corpusDatasets.id, datasetId), eq(corpusDatasets.companyId, companyId)));
    return rows[0] ? toDataset(rows[0]) : null;
  }

  async listDatasets(companyId: string): Promise<CorpusDataset[]> {
    const rows = await this.db
      .select()
      .from(corpusDatasets)
      .where(eq(corpusDatasets.companyId, companyId))
      .orderBy(corpusDatasets.createdAt);
    return rows.map(toDataset);
  }

  async createDocument(input: CreateCorpusDocumentInput): Promise<CorpusDocument> {
    const rows = await this.db
      .insert(corpusDocuments)
      .values({
        companyId: input.companyId,
        datasetId: input.datasetId,
        title: input.title,
        sourceUri: input.sourceUri ?? null,
        blobKey: input.blobKey ?? null,
        contentType: input.contentType ?? null,
        byteSize: input.byteSize ?? null,
        contentHash: input.contentHash ?? null,
        metadata: input.metadata ?? {},
        status: "queued",
      })
      .returning();
    return toDocument(rows[0]!);
  }

  async getDocument(companyId: string, documentId: string): Promise<CorpusDocument | null> {
    const rows = await this.db
      .select()
      .from(corpusDocuments)
      .where(and(eq(corpusDocuments.id, documentId), eq(corpusDocuments.companyId, companyId)));
    return rows[0] ? toDocument(rows[0]) : null;
  }

  async listDocuments(filter: CorpusDocumentListFilter): Promise<CorpusDocument[]> {
    const conditions = [eq(corpusDocuments.companyId, filter.companyId)];
    if (filter.datasetId) conditions.push(eq(corpusDocuments.datasetId, filter.datasetId));
    if (filter.status) conditions.push(eq(corpusDocuments.status, filter.status));
    let query = this.db
      .select()
      .from(corpusDocuments)
      .where(and(...conditions))
      .orderBy(desc(corpusDocuments.createdAt));
    if (filter.limit != null) query = query.limit(filter.limit) as typeof query;
    if (filter.offset != null) query = query.offset(filter.offset) as typeof query;
    const rows = await query;
    return rows.map(toDocument);
  }

  async deleteDocument(companyId: string, documentId: string): Promise<boolean> {
    const rows = await this.db
      .delete(corpusDocuments)
      .where(and(eq(corpusDocuments.id, documentId), eq(corpusDocuments.companyId, companyId)))
      .returning({ id: corpusDocuments.id });
    return rows.length > 0;
  }

  async updateDocumentStatus(
    companyId: string,
    documentId: string,
    status: CorpusParseStatus,
    details?: { parseError?: string | null; parserVersion?: string | null },
  ): Promise<CorpusDocument> {
    const current = await this.getDocument(companyId, documentId);
    if (!current) throw new Error(`corpus: document ${documentId} not found`);
    assertDocumentStatusTransition(current.status, status);
    const rows = await this.db
      .update(corpusDocuments)
      .set({
        status,
        parseError: details?.parseError === undefined ? current.parseError : details.parseError,
        parserVersion:
          details?.parserVersion === undefined ? current.parserVersion : details.parserVersion,
        parsedAt: status === "ready" ? new Date() : current.parsedAt,
        updatedAt: new Date(),
      })
      .where(and(eq(corpusDocuments.id, documentId), eq(corpusDocuments.companyId, companyId)))
      .returning();
    return toDocument(rows[0]!);
  }

  async replaceDocumentChunks(input: ReplaceCorpusChunksInput): Promise<CorpusChunk[]> {
    return await this.db.transaction(async (tx) => {
      await tx
        .delete(corpusChunks)
        .where(
          and(eq(corpusChunks.documentId, input.documentId), eq(corpusChunks.companyId, input.companyId)),
        );
      if (input.chunks.length === 0) return [];
      const rows = await tx
        .insert(corpusChunks)
        .values(
          input.chunks.map((chunk) => ({
            companyId: input.companyId,
            documentId: input.documentId,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            embedding: chunk.embedding,
            tokenCount: chunk.tokenCount ?? null,
            metadata: chunk.metadata ?? {},
          })),
        )
        .returning();
      return rows
        .map(toChunk)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
    });
  }

  async listDocumentChunks(companyId: string, documentId: string): Promise<CorpusChunk[]> {
    const rows = await this.db
      .select()
      .from(corpusChunks)
      .where(and(eq(corpusChunks.documentId, documentId), eq(corpusChunks.companyId, companyId)))
      .orderBy(corpusChunks.chunkIndex);
    return rows.map(toChunk);
  }
}

// Re-exported for part B (SearchIndex): the FTS expression used by hybrid
// search. Kept here so the tsvector expression has exactly one definition.
export const corpusChunkFtsMatches = (query: string) =>
  sql`${corpusChunks.fts} @@ websearch_to_tsquery('english', ${query})`;
