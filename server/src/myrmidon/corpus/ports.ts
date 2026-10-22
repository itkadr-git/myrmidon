// server/src/myrmidon/corpus/ports.ts
//
// myrmidon(1.6.6 CORPUS-2.0 ч.C): the ports the corpus module consumes.
//
// This file is a LOCAL COPY of the port surface of `packages/corpus` (parts A
// and B). The issue OPE-6165 fixes the order explicitly: "типы брать из ч.A
// после его мержа; до мержа — локальная копия типов, заменить на импорт перед
// PR". Part A owns `packages/corpus/**` — this module never imports the package
// until that merge lands (the file boundary is hard: only parts A and B touch
// `packages/corpus/**`).
//
// Switch-over recipe (the one edit that follows part A's merge): delete
// everything up to the "wire-in" marker below and re-export the package types
// instead — `export * from "@paperclipai/corpus/ports";` — then let `tsc` point
// at every place where the package names a field differently; the mapping lives
// in `service.ts` and `worker.ts` only, so the API contract in
// `packages/shared/src/myrmidon-corpus.ts` does not move.
//
// The module talks to the corpus ONLY through these five ports. It has no SQL,
// no embedding call and no HTTP client of its own — that is parts A/B, and the
// whole point of the port boundary: the parse service is a separate HTTP
// service, the store is the board's database, the index is pgvector.

import type {
  CorpusDocumentStatus,
  CorpusParseJobState,
  CorpusSearchMode,
  CorpusSettings,
  CorpusStats,
} from "@paperclipai/shared";

// Re-exported so that a consumer of these ports needs one import, not two; part
// A's package does the same from its own module.
export type {
  CorpusDocumentStatus,
  CorpusParseJobState,
  CorpusSearchMode,
  CorpusSettings,
  CorpusStats,
};

export interface CorpusDatasetRecord {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
  readyCount: number;
  failedCount: number;
  chunkCount: number;
}

export interface CorpusDocumentRecord {
  id: string;
  companyId: string;
  datasetId: string;
  filename: string;
  mimeType: string | null;
  byteSize: number;
  /** Handle of the BlobStore object holding the uploaded bytes. */
  blobRef: string;
  status: CorpusDocumentStatus;
  chunkCount: number;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  parsedAt: string | null;
}

export interface CorpusJobRecord {
  id: string;
  companyId: string;
  datasetId: string;
  documentId: string;
  state: CorpusParseJobState;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Whole-company counters; the store computes them, the route only formats them. */
export type CorpusStoreCounters = CorpusStats;

export interface CorpusStorePort {
  listDatasets(companyId: string): Promise<CorpusDatasetRecord[]>;
  getDataset(companyId: string, datasetId: string): Promise<CorpusDatasetRecord | null>;
  createDataset(input: {
    companyId: string;
    name: string;
    description: string | null;
  }): Promise<CorpusDatasetRecord>;
  updateDataset(
    companyId: string,
    datasetId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<CorpusDatasetRecord | null>;
  deleteDataset(companyId: string, datasetId: string): Promise<boolean>;
  listDocuments(
    companyId: string,
    datasetId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<CorpusDocumentRecord[]>;
  getDocument(companyId: string, documentId: string): Promise<CorpusDocumentRecord | null>;
  createDocument(input: {
    companyId: string;
    datasetId: string;
    filename: string;
    mimeType: string | null;
    byteSize: number;
    blobRef: string;
    maxAttempts: number;
  }): Promise<CorpusDocumentRecord>;
  updateDocument(
    companyId: string,
    documentId: string,
    patch: Partial<
      Pick<
        CorpusDocumentRecord,
        "status" | "chunkCount" | "error" | "attempts" | "parsedAt" | "blobRef"
      >
    >,
  ): Promise<CorpusDocumentRecord | null>;
  deleteDocument(companyId: string, documentId: string): Promise<boolean>;
  countDocuments(companyId: string, datasetId: string): Promise<number>;
  getJob(companyId: string, jobId: string): Promise<CorpusJobRecord | null>;
  counters(companyId: string): Promise<CorpusStoreCounters>;
}

export interface BlobStorePort {
  put(input: {
    companyId: string;
    documentId: string;
    filename: string;
    mimeType: string | null;
    bytes: Uint8Array;
  }): Promise<{ ref: string; byteSize: number }>;
  get(ref: string): Promise<Uint8Array>;
  delete(ref: string): Promise<void>;
}

export interface WorkQueuePort {
  enqueue(input: {
    companyId: string;
    datasetId: string;
    documentId: string;
    maxAttempts: number;
  }): Promise<CorpusJobRecord>;
  /** Oldest queued jobs, at most `limit`; `[]` when the queue is empty. */
  claim(input: { limit: number }): Promise<CorpusJobRecord[]>;
  complete(companyId: string, jobId: string): Promise<void>;
  /** Release the job for another attempt; the store settles it `failed` at `maxAttempts`. */
  fail(companyId: string, jobId: string, reason: string): Promise<CorpusJobRecord | null>;
}

export interface ParsedChunk {
  text: string;
  /** Position of the chunk inside the document, 0-based. */
  index: number;
  metadata?: Record<string, unknown>;
}

export interface ParsedDocument {
  text: string;
  chunks: ParsedChunk[];
}

/**
 * The document-parse service (PDF/scan → text), reached over HTTP. Part B owns
 * the real client; the base URL comes from the module settings.
 */
export interface DocumentParsePort {
  parse(input: {
    bytes: Uint8Array;
    filename: string;
    mimeType: string | null;
    baseUrl: string;
    timeoutMs: number;
  }): Promise<ParsedDocument>;
}

export interface SearchHitRecord {
  chunkId: string;
  documentId: string;
  datasetId: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

export interface SearchIndexPort {
  /** Index the chunks of one document; returns how many it wrote. */
  indexDocument(input: {
    companyId: string;
    datasetId: string;
    documentId: string;
    chunks: ParsedChunk[];
    embedderModel: string;
    embedderDimensions: number;
    embedderBaseUrl: string | null;
  }): Promise<number>;
  deleteDocument(companyId: string, documentId: string): Promise<void>;
  search(input: {
    companyId: string;
    datasetId: string;
    query: string;
    limit: number;
    mode: CorpusSearchMode;
    embedderModel: string;
    embedderDimensions: number;
    embedderBaseUrl: string | null;
  }): Promise<SearchHitRecord[]>;
  countChunks(companyId: string, datasetId?: string): Promise<number>;
}

export interface CorpusPorts {
  store: CorpusStorePort;
  blobs: BlobStorePort;
  queue: WorkQueuePort;
  parser: DocumentParsePort;
  index: SearchIndexPort;
}

export interface CorpusPortContext {
  env: Record<string, string | undefined>;
  settings: CorpusSettings;
}

/**
 * Builds the ports of one call. `null` means "this process cannot serve the
 * corpus" (the database half of parts A/B is not wired yet): the settings route
 * then reports `available: false`, every data route answers 503 and the parse
 * sweep is a no-op — the module stays silent on the fleet until the ports land.
 */
export type CorpusPortsResolver = (context: CorpusPortContext) => CorpusPorts | null;