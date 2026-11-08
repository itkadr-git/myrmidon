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
  datasetIds?: string[];
  /** Raw user query text; the index handles tsquery construction. */
  text: string;
  /**
   * Query embedding; must have CORPUS_EMBEDDING_DIMENSIONS components. It may be a promise of the
   * embedding: the full-text ranking, which does not need the vector, starts at once, and the vector
   * ranking starts when the promise resolves. A promise that rejects fails the search.
   */
  embedding?: number[] | PromiseLike<number[]>;
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
  /**
   * Re-parse on request: an existing job of the same (document, parser version) goes back to
   * `pending` with its attempts, error and backoff cleared WHATEVER its status is (without this
   * flag only a `failed` job is re-armed). For the caller that knows the document is not being
   * parsed any more, e.g. the re-parse of a failed document.
   */
  reset?: boolean;
};

export type ClaimedParseJob = CorpusParseJob;

export interface WorkQueue {
  /**
   * Enqueues a parse job. Idempotent on (document_id, parser_version): a
   * second call with the same pair returns the existing job instead of
   * creating a duplicate, UNLESS the existing job is in `failed` status with
   * retries exhausted — then it is re-armed to `pending` (the "rollback of a
   * failed job into the queue again" path). With `reset` the existing job is
   * re-armed whatever its status is.
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

  /**
   * Gives a claimed job back unfinished, through no fault of its own: the worker holding it is
   * shutting down. The job returns to `pending` at once (no backoff) and the attempt the claim
   * used is refunded, so a deploy never eats into `maxAttempts`. Only a `running` job moves;
   * resolves `null` for any other (already settled, unknown, another company's).
   */
  release(companyId: string, jobId: string, reason?: string): Promise<CorpusParseJob | null>;

  /**
   * Settles the jobs a dead worker left `running` (the process was killed or lost, so nobody will
   * ever `complete` or `fail` them): back to `pending` at once, to be claimed again. The claim
   * already counted the attempt and it stays counted - a document that takes the process down
   * every time must not loop forever - so a job whose attempts are used up (`attempts >=
   * maxAttempts`) is settled `failed` instead. Returns the settled jobs (`status` tells which
   * way each went). `companyId` limits it to one company; without it, the whole queue.
   *
   * For the single worker that starts up: it must run before that worker claims anything, or it
   * would take the worker's own live jobs for orphans.
   */
  releaseRunning(options?: { companyId?: string }): Promise<CorpusParseJob[]>;
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

export type DocumentParseOptions = {
  /**
   * Aborts the parse: the call gives up at once and, when it already holds a job in the parse
   * service, cancels it there (`DELETE /v1/parse/{jobId}`) instead of leaving it to run.
   */
  signal?: AbortSignal;
};

export interface DocumentParser {
  /**
   * Parses a document into chunks via the external HTTP parse service.
   * Implementations carry their own base URL/credentials; the port is pure.
   */
  parse(request: DocumentParseRequest, options?: DocumentParseOptions): Promise<DocumentParseResult>;
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
