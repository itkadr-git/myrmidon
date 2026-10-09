/**
 * Corpus module ports: interfaces only, no implementations.
 *
 * Every port is company-scoped: all read/write methods take `companyId` and
 * implementations MUST enforce it (a row of another company is invisible).
 *
 * Dialect rule: no Postgres/pgvector operators appear in these interfaces or
 * anywhere outside the `postgres/` implementation layer. Callers work with
 * plain domain values (number[] embeddings, plain text queries); the store
 * translates them into `<=>`, `to_tsvector`, RRF composition, etc.
 */

import type {
  CorpusChunk,
  CorpusDataset,
  CorpusDocument,
  CorpusModuleSettings,
  CorpusParseJob,
  CorpusParseStatus,
} from "./domain.js";

// ---------------------------------------------------------------------------
// CorpusStore — datasets, documents, chunks
// ---------------------------------------------------------------------------

export type CreateCorpusDatasetInput = {
  companyId: string;
  name: string;
  description?: string | null;
  embeddingModel?: string;
};

export type CreateCorpusDocumentInput = {
  companyId: string;
  datasetId: string;
  title: string;
  sourceUri?: string | null;
  blobKey?: string | null;
  contentType?: string | null;
  byteSize?: number | null;
  contentHash?: string | null;
  metadata?: Record<string, unknown>;
};

export type CorpusDocumentListFilter = {
  companyId: string;
  datasetId?: string;
  status?: CorpusParseStatus;
  limit?: number;
  offset?: number;
};

export type ReplaceCorpusChunksInput = {
  companyId: string;
  documentId: string;
  chunks: Array<{
    chunkIndex: number;
    content: string;
    embedding: number[] | null;
    tokenCount?: number | null;
    metadata?: Record<string, unknown>;
  }>;
};

export interface CorpusStore {
  createDataset(input: CreateCorpusDatasetInput): Promise<CorpusDataset>;
  getDataset(companyId: string, datasetId: string): Promise<CorpusDataset | null>;
  listDatasets(companyId: string): Promise<CorpusDataset[]>;

  /**
   * Creates a document in `queued` status. Implementations do not enqueue a
   * parse job — that is the WorkQueue's responsibility (the caller composes
   * both, typically inside `enqueueParse`).
   */
  createDocument(input: CreateCorpusDocumentInput): Promise<CorpusDocument>;
  getDocument(companyId: string, documentId: string): Promise<CorpusDocument | null>;
  listDocuments(filter: CorpusDocumentListFilter): Promise<CorpusDocument[]>;
  deleteDocument(companyId: string, documentId: string): Promise<boolean>;

  /**
   * Moves a document between parse statuses. Implementations reject illegal
   * transitions (see `canTransitionDocumentStatus` in domain.ts).
   */
  updateDocumentStatus(
    companyId: string,
    documentId: string,
    status: CorpusParseStatus,
    details?: { parseError?: string | null; parserVersion?: string | null },
  ): Promise<CorpusDocument>;

  /**
   * Atomically replaces all chunks of a document (used after a successful
   * parse + embedding). Returns the stored chunks.
   */
  replaceDocumentChunks(input: ReplaceCorpusChunksInput): Promise<CorpusChunk[]>;
  listDocumentChunks(companyId: string, documentId: string): Promise<CorpusChunk[]>;
}

// ---------------------------------------------------------------------------
// SearchIndex — hybrid retrieval (implemented by part B; port defined here)
// ---------------------------------------------------------------------------

export type CorpusSearchQuery = {
  companyId: string;
  datasetId?: string;
  /** Raw user query text; the index handles tsquery construction. */
  text: string;
  /** Query embedding; must have CORPUS_EMBEDDING_DIMENSIONS components. */
  embedding?: number[];
  limit?: number;
};

export type CorpusSearchHit = {
  chunkId: string;
  documentId: string;
  datasetId: string;
  content: string;
  /** Fused score (RRF when hybrid), higher is better. */
  score: number;
  metadata: Record<string, unknown>;
};

export interface SearchIndex {
  /**
   * Hybrid vector + full-text search over ready documents. When both `text`
   * and `embedding` are given the index fuses candidates with reciprocal rank
   * fusion (k0 = 60, 100 candidates per leg); each leg alone is also valid.
   * Chunks of documents not in `ready` status are never returned.
   */
  search(query: CorpusSearchQuery): Promise<CorpusSearchHit[]>;

  /** Removes a document from the index (on delete or before re-indexing). */
  removeDocument(companyId: string, documentId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// WorkQueue — parse job scheduling and worker-side claiming
// ---------------------------------------------------------------------------

export type EnqueueParseJobInput = {
  companyId: string;
  documentId: string;
  parserVersion: string;
  maxAttempts?: number;
};

export type ClaimedParseJob = CorpusParseJob;

export interface WorkQueue {
  /**
   * Enqueues a parse job. Idempotent on (document_id, parser_version): a
   * second call with the same pair returns the existing job instead of
   * creating a duplicate, UNLESS the existing job is in `failed` status with
   * retries exhausted — then it is re-armed to `pending` (the "rollback of a
   * failed job into the queue again" path).
   */
  enqueue(input: EnqueueParseJobInput): Promise<CorpusParseJob>;

  getJob(companyId: string, jobId: string): Promise<CorpusParseJob | null>;
  listJobsForDocument(companyId: string, documentId: string): Promise<CorpusParseJob[]>;

  /**
   * Claims the next due pending job for the worker. Returns null when the
   * queue is empty. Claimed jobs move to `running`; an implementation must
   * make claiming atomic so two workers never take the same job.
   */
  claimNext(companyId: string, now?: Date): Promise<ClaimedParseJob | null>;

  /** Marks a claimed job done. */
  complete(companyId: string, jobId: string): Promise<void>;

  /**
   * Marks a claimed job failed. While attempts < maxAttempts the job goes back
   * to `pending` with a backoff (`parseJobRetryDelayMs`); once exhausted it is
   * `failed` and stays failed until re-armed via `enqueue`.
   */
  fail(companyId: string, jobId: string, error: string): Promise<CorpusParseJob>;
}

// ---------------------------------------------------------------------------
// BlobStore — raw document bytes
// ---------------------------------------------------------------------------

export type BlobStat = {
  key: string;
  byteSize: number;
};

export interface BlobStore {
  /**
   * Stores bytes under a caller-chosen key. Keys are company-prefixed by the
   * caller (`<companyId>/<documentId>/<filename>`); implementations treat the
   * key as opaque but MUST reject keys escaping their root (`..`, absolute).
   * Overwriting an existing key is allowed (idempotent re-upload).
   */
  put(key: string, data: Uint8Array): Promise<BlobStat>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<boolean>;
  stat(key: string): Promise<BlobStat | null>;
}

// ---------------------------------------------------------------------------
// DocumentParser — HTTP client port of the external parse service
// ---------------------------------------------------------------------------

export type DocumentParseRequest = {
  /** Absolute URL the parse service can fetch, or null when bytes are sent. */
  sourceUri: string | null;
  /** Raw bytes when the service cannot reach the blob store. */
  content: Uint8Array | null;
  contentType: string | null;
  title: string;
  parserVersion: string;
};

export type ParsedDocumentChunk = {
  chunkIndex: number;
  content: string;
  tokenCount?: number | null;
  metadata?: Record<string, unknown>;
};

export type DocumentParseResult = {
  chunks: ParsedDocumentChunk[];
  /** Opaque parser metadata (page count, detected language, ...). */
  metadata: Record<string, unknown>;
};

export interface DocumentParser {
  /**
   * Parses a document into chunks via the external HTTP parse service.
   * Implementations carry their own base URL/credentials; the port is pure.
   */
  parse(request: DocumentParseRequest): Promise<DocumentParseResult>;
}

// ---------------------------------------------------------------------------
// Embedder — OpenAI-compatible embeddings endpoint (company gateway)
// ---------------------------------------------------------------------------

export type EmbedRequest = {
  texts: string[];
  /** Defaults to CORPUS_DEFAULT_EMBEDDING_MODEL. */
  model?: string;
  /** Defaults to CORPUS_EMBEDDING_DIMENSIONS. */
  dimensions?: number;
};

export type EmbedResult = {
  embeddings: number[][];
  model: string;
  dimensions: number;
};

export interface Embedder {
  /**
   * Embeds a batch of texts through the OpenAI-compatible endpoint configured
   * for the module (the company LLM gateway). Implementations validate the
   * returned dimensionality against the request.
   */
  embed(request: EmbedRequest): Promise<EmbedResult>;
}

// ---------------------------------------------------------------------------
// Module settings
// ---------------------------------------------------------------------------

export interface CorpusSettingsStore {
  getSettings(companyId: string): Promise<CorpusModuleSettings>;
  updateSettings(
    companyId: string,
    patch: Partial<Omit<CorpusModuleSettings, "extra">> & { extra?: Record<string, unknown> },
  ): Promise<CorpusModuleSettings>;
}
