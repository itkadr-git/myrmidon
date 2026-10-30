import { createHash } from "node:crypto";
import { assertEmbeddingVector, isL2Normalized, l2Normalize } from "../search/vector.js";

export const DEFAULT_RAGFLOW_PAGE_SIZE = 500;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 64;
export const DEFAULT_EMBEDDING_CONCURRENCY = 4;
export const DEFAULT_EMBEDDING_MODEL = "hindsight-embed-bge-m3";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

export type RagflowDataset = {
  id: string;
  name: string;
  description?: string | null;
  chunk_count?: number;
  chunk_num?: number;
  document_count?: number;
  doc_num?: number;
  embedding_model?: string;
};

export type RagflowDocument = {
  id: string;
  name?: string;
  location?: string;
  size?: number;
  chunk_count?: number;
  chunk_num?: number;
  type?: string;
  run?: string | number;
  create_time?: number;
  update_time?: number;
  [key: string]: unknown;
};

export type RagflowChunk = {
  id: string;
  content: string;
  positions?: unknown;
  important_keywords?: string[];
  [key: string]: unknown;
};

type RagflowEnvelope<T> = { code: number; message?: string; data: T };
type Page<T> = { items: T[]; total?: number };

export type RagflowSource = {
  baseUrl: string;
  listDatasets(): Promise<RagflowDataset[]>;
  listDocuments(datasetId: string): AsyncIterable<RagflowDocument>;
  listChunks(datasetId: string, documentId: string): AsyncIterable<RagflowChunk>;
  countChunks?(datasetId: string, documentId: string): Promise<number | undefined>;
};

export type CorpusImportDataset = {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  metadata: Record<string, unknown>;
};

export type CorpusImportDocument = {
  id: string;
  companyId: string;
  datasetId: string;
  title: string;
  sourceUri: string;
  byteSize: number | null;
  contentType: string | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
};

export type CorpusImportChunk = {
  id: string;
  companyId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  /** Null preserves a previously stored embedding during an idempotent upsert. */
  embedding: number[] | null;
  metadata: Record<string, unknown>;
};

export type CorpusImportTarget = {
  upsertDataset(dataset: CorpusImportDataset): Promise<void>;
  upsertDocument(document: CorpusImportDocument): Promise<void>;
  getChunkStates(companyId: string, ids: string[]): Promise<Map<string, {
    content: string;
    embedding: number[] | null;
    embeddingModel: string | null;
    embeddingDimensions: number | null;
    embeddingContentHash: string | null;
  }>>;
  upsertChunks(chunks: CorpusImportChunk[]): Promise<void>;
  markDocumentReady(companyId: string, documentId: string): Promise<void>;
};

export type CorpusImporterOptions = {
  source: RagflowSource;
  target: CorpusImportTarget;
  embed(texts: string[]): Promise<number[][]>;
  companyId: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingBatchSize?: number;
  embeddingConcurrency?: number;
  chunkCountTolerance?: number;
  onProgress?: (progress: CorpusImportProgress) => void;
};

export type CorpusImportProgress = {
  datasetId?: string;
  datasetName?: string;
  documentId?: string;
  phase: "dataset" | "document" | "chunks" | "complete";
  datasets: number;
  documents: number;
  chunks: number;
  embedded: number;
  reused: number;
};

export type CorpusImportSummary = {
  datasets: number;
  documents: number;
  chunks: number;
  embedded: number;
  reused: number;
  durationMs: number;
};

export class RagflowApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "RagflowApiError";
  }
}

/** Implements the read-only RAGFlow API. It never invokes document parsing. */
export function createRagflowSource(options: {
  baseUrl: string;
  apiKey: string;
  pageSize?: number;
  fetchImpl?: typeof fetch;
}): RagflowSource {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageSize = options.pageSize ?? DEFAULT_RAGFLOW_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be positive");

  async function get<T>(path: string): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" },
    });
    if (!response.ok) throw new RagflowApiError(`RAGFlow request failed (${response.status})`, response.status);
    const payload = await response.json() as RagflowEnvelope<T>;
    if (payload.code !== 0) throw new RagflowApiError(`RAGFlow API error ${payload.code}: ${payload.message ?? "unknown error"}`);
    return payload.data;
  }

  async function* pages<T>(pathForPage: (page: number) => string, unpack: (data: unknown) => Page<T>): AsyncIterable<T> {
    let page = 1;
    let received = 0;
    while (true) {
      const result = unpack(await get<unknown>(pathForPage(page)));
      for (const item of result.items) yield item;
      received += result.items.length;
      if (result.total !== undefined && received > result.total) throw new RagflowApiError("RAGFlow page returned more items than its reported total");
      if ((result.items.length === 0 || result.items.length < pageSize) && result.total !== undefined && received < result.total) {
        throw new RagflowApiError(`RAGFlow pagination ended early: received ${received} of ${result.total}`);
      }
      if (result.items.length === 0 || result.items.length < pageSize || (result.total !== undefined && received >= result.total)) return;
      page += 1;
    }
  }

  return {
    baseUrl,
    async listDatasets() {
      const datasets: RagflowDataset[] = [];
      let reportedTotal: number | undefined;
      let page = 1;
      while (true) {
        const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
        const data = await get<unknown>(`/api/v1/datasets?${query}`);
        let pageItems: RagflowDataset[];
        if (Array.isArray(data)) {
          pageItems = data as RagflowDataset[];
        } else {
          if (typeof data !== "object" || data === null) throw new RagflowApiError("RAGFlow datasets response is invalid");
          const envelope = data as { datasets?: unknown; total_datasets?: unknown; total?: unknown };
          if (!Array.isArray(envelope.datasets)) throw new RagflowApiError("RAGFlow datasets response has no datasets array");
          pageItems = envelope.datasets as RagflowDataset[];
          const total = sourceCount(envelope.total_datasets, envelope.total);
          if (total !== undefined && reportedTotal !== undefined && reportedTotal !== total) throw new RagflowApiError("RAGFlow returned inconsistent dataset totals across pages");
          if (total !== undefined) reportedTotal = total;
        }
        datasets.push(...pageItems);
        if (reportedTotal !== undefined && datasets.length > reportedTotal) throw new RagflowApiError("RAGFlow returned more datasets than its reported total");
        if (reportedTotal !== undefined && datasets.length === reportedTotal) return datasets;
        if (pageItems.length === 0 || pageItems.length < pageSize) {
          if (reportedTotal !== undefined && datasets.length !== reportedTotal) throw new RagflowApiError(`RAGFlow dataset count mismatch: source reports ${reportedTotal}, listed ${datasets.length}`);
          return datasets;
        }
        page += 1;
      }
    },
    async *listDocuments(datasetId) {
      yield* pages<RagflowDocument>(
        (page) => `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents?page=${page}&page_size=${pageSize}`,
        (data) => {
          if (typeof data !== "object" || data === null) throw new RagflowApiError("RAGFlow documents response is invalid");
          const envelope = data as { docs?: unknown; total?: unknown; total_documents?: unknown };
          if (!Array.isArray(envelope.docs)) throw new RagflowApiError("RAGFlow documents response has no docs array");
          const total = typeof envelope.total_documents === "number" ? envelope.total_documents : typeof envelope.total === "number" ? envelope.total : undefined;
          return { items: envelope.docs as RagflowDocument[], total };
        },
      );
    },
    async *listChunks(datasetId, documentId) {
      const encodedDatasetId = encodeURIComponent(datasetId);
      const encodedDocumentId = encodeURIComponent(documentId);
      yield* pages(
        (page) => `/api/v1/datasets/${encodedDatasetId}/documents/${encodedDocumentId}/chunks?page=${page}&page_size=${pageSize}`,
        (data) => {
          if (typeof data !== "object" || data === null) throw new RagflowApiError("RAGFlow chunks response is invalid");
          const envelope = data as { chunks?: unknown; total?: unknown; total_chunks?: unknown };
          if (!Array.isArray(envelope.chunks)) throw new RagflowApiError("RAGFlow chunks response has no chunks array");
          const total = typeof envelope.total_chunks === "number" ? envelope.total_chunks : typeof envelope.total === "number" ? envelope.total : undefined;
          return { items: envelope.chunks as RagflowChunk[], total };
        },
      );
    },
    async countChunks(datasetId, documentId) {
      const data = await get<unknown>(`/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/chunks?page=1&page_size=1`);
      if (typeof data !== "object" || data === null) throw new RagflowApiError("RAGFlow chunks response is invalid");
      const envelope = data as { total?: unknown; total_chunks?: unknown };
      const total = sourceCount(envelope.total_chunks, envelope.total);
      if (total !== undefined) return total;
      let count = 0;
      for await (const _chunk of this.listChunks(datasetId, documentId)) count += 1;
      return count;
    },
  };
}

export async function importRagflowCorpus(options: CorpusImporterOptions): Promise<CorpusImportSummary> {
  const startedAt = Date.now();
  const dimensions = options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const batchSize = options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
  const concurrency = options.embeddingConcurrency ?? DEFAULT_EMBEDDING_CONCURRENCY;
  const importBatchSize = batchSize * concurrency;
  if (!Number.isSafeInteger(importBatchSize)) throw new RangeError("batchSize * concurrency is too large");
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new RangeError("embeddingDimensions must be positive");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError("embeddingBatchSize must be positive");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("embeddingConcurrency must be positive");

  const progress: CorpusImportProgress = { phase: "dataset", datasets: 0, documents: 0, chunks: 0, embedded: 0, reused: 0 };
  const report = () => options.onProgress?.({ ...progress });
  const datasets = await options.source.listDatasets();
  const tolerance = options.chunkCountTolerance ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw new RangeError("chunkCountTolerance must be between 0 and 1");
  const embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;

  // Source preflight completes before the importer writes rows or calls the
  // embedder. Prefer RAGFlow's per-document chunk totals; when absent, count
  // the source's listed chunks in this streaming preflight pass.
  const documentsByDataset = new Map<string, RagflowDocument[]>();
  const expectedChunksByDocument = new Map<string, number>();
  const sourceDatasetCount = datasets.length;
  let sourceDocumentCount = 0;
  let sourceChunkCount = 0;
  for (const dataset of datasets) {
    if (!dataset.id || !dataset.name) throw new RagflowApiError("RAGFlow dataset is missing id or name");
    const documents: RagflowDocument[] = [];
    for await (const document of options.source.listDocuments(dataset.id)) documents.push(document);
    documentsByDataset.set(dataset.id, documents);
    sourceDocumentCount += documents.length;
    const declaredDocuments = sourceCount(dataset.document_count, dataset.doc_num);
    if (declaredDocuments !== undefined && declaredDocuments !== documents.length) {
      throw new RagflowApiError(`RAGFlow document count mismatch for dataset ${dataset.id}: source reports ${declaredDocuments}, listed ${documents.length}`);
    }
    let datasetChunks = 0;
    for (const document of documents) {
      if (!document.id) throw new RagflowApiError(`RAGFlow document in dataset ${dataset.id} is missing an id`);
      const declaredChunks = sourceCount(document.chunk_count, document.chunk_num);
      const sourceChunkCount = options.source.countChunks
        ? sourceCount(await options.source.countChunks(dataset.id, document.id))
        : undefined;
      if (declaredChunks !== undefined && sourceChunkCount !== undefined && declaredChunks !== sourceChunkCount) {
        throw new RagflowApiError(`RAGFlow chunk count mismatch for ${document.id}: document reports ${declaredChunks}, source endpoint reports ${sourceChunkCount}`);
      }
      const expectedChunks = sourceChunkCount ?? declaredChunks;
      if (expectedChunks === undefined) {
        throw new RagflowApiError(`RAGFlow provides no source chunk total for ${document.id}; cannot preflight before embedding`);
      }
      expectedChunksByDocument.set(JSON.stringify([dataset.id, document.id]), expectedChunks);
      datasetChunks += expectedChunks;
    }
    const declaredChunks = sourceCount(dataset.chunk_count, dataset.chunk_num);
    if (declaredChunks !== undefined && declaredChunks !== datasetChunks) {
      throw new RagflowApiError(`RAGFlow chunk count mismatch for dataset ${dataset.id}: source reports ${declaredChunks}, listed documents report ${datasetChunks}`);
    }
    sourceChunkCount += datasetChunks;
  }
  const sourceMinimumChunks = Math.floor(sourceChunkCount * (1 - tolerance));
  const sourceMaximumChunks = Math.ceil(sourceChunkCount * (1 + tolerance));

  for (const dataset of datasets) {
    if (!dataset.id || !dataset.name) throw new RagflowApiError("RAGFlow dataset is missing id or name");
    const datasetId = stableUuid("dataset", JSON.stringify([options.companyId, dataset.id]));
    progress.phase = "dataset";
    progress.datasetId = dataset.id;
    progress.datasetName = dataset.name;
    await options.target.upsertDataset({
      id: datasetId,
      companyId: options.companyId,
      name: `RAGFlow: ${dataset.name} [${dataset.id}]`,
      description: dataset.description ?? null,
      embeddingModel,
      embeddingDimensions: dimensions,
      metadata: { ragflowDatasetId: dataset.id, ragflowEmbeddingModel: dataset.embedding_model ?? null },
    });
    progress.datasets += 1;
    report();

    for (const document of documentsByDataset.get(dataset.id) ?? []) {
      if (!document.id) throw new RagflowApiError(`RAGFlow document in dataset ${dataset.id} is missing an id`);
      const runState = document.run === undefined || document.run === null ? "" : String(document.run).toUpperCase();
      // The documented completed statuses are textual DONE or numeric 3. Fail closed
      // for missing/unknown values: the importer must never copy a partial RAGFlow index.
      if (!["DONE", "3"].includes(runState)) {
        throw new RagflowApiError(`RAGFlow document ${document.id} is not ready (run=${runState || "unknown"})`);
      }
      const documentId = stableUuid("document", JSON.stringify([options.companyId, dataset.id, document.id]));
      const filename = document.name ?? document.location ?? document.id;
      const sourceUri = `${options.source.baseUrl.replace(/\/+$/, "")}/api/v1/datasets/${encodeURIComponent(dataset.id)}/documents/${encodeURIComponent(document.id)}`;
      await options.target.upsertDocument({
        id: documentId,
        companyId: options.companyId,
        datasetId,
        title: filename,
        sourceUri,
        byteSize: safeInteger(document.size),
        contentType: mimeTypeFromName(filename, document.type),
        contentHash: null,
        metadata: { ragflowDatasetId: dataset.id, ragflowDocumentId: document.id, ragflow: document },
      });
      progress.phase = "document";
      progress.documentId = document.id;
      progress.documents += 1;
      report();

      let documentChunks = 0;
      let nextChunkIndex = 0;
      const batch: Array<{ source: RagflowChunk; index: number }> = [];
      const flush = async () => {
        if (batch.length === 0) return;
        const rows = batch.splice(0, batch.length);
        const targetChunks = rows.map(({ source, index }) => ({
          id: stableUuid("chunk", JSON.stringify([options.companyId, dataset.id, document.id, source.id || index])),
          companyId: options.companyId,
          documentId,
          chunkIndex: index,
          content: source.content,
          embedding: null as number[] | null,
          metadata: {
            ragflowDatasetId: dataset.id,
            ragflowDocumentId: document.id,
            ragflowChunkId: source.id || null,
            embeddingContentHash: createHash("sha256").update(source.content).digest("hex"),
            embeddingModel,
            embeddingDimensions: dimensions,
            positions: source.positions ?? [],
            importantKeywords: source.important_keywords ?? [],
          },
        }));
        const existing = await options.target.getChunkStates(options.companyId, targetChunks.map((chunk) => chunk.id));
        // Persist RAGFlow's parsed content/positions before a possibly long or fallible
        // embedding call. Keep metadata bound to the vector that is actually stored until
        // its replacement succeeds, so retries cannot mistake a stale vector for current.
        await options.target.upsertChunks(targetChunks.map((chunk) => {
          const state = existing.get(chunk.id);
          return {
            ...chunk,
            embedding: state?.embedding ?? null,
            metadata: {
              ...chunk.metadata,
              embeddingModel: state?.embeddingModel ?? null,
              embeddingDimensions: state?.embeddingDimensions ?? null,
              embeddingContentHash: state?.embeddingContentHash ?? null,
            },
          };
        }));
        const pending = targetChunks.filter((chunk) => {
          const state = existing.get(chunk.id);
          const embeddingMatches = state?.embedding != null
            && isReusableEmbedding(state.embedding, dimensions)
            && state.embeddingModel === embeddingModel
            && state.embeddingDimensions === dimensions
            && state.embeddingContentHash === chunk.metadata.embeddingContentHash;
          return !embeddingMatches || state.content !== chunk.content;
        });
        if (pending.length > 0) {
          await mapWithConcurrency(splitEvery(pending, batchSize), concurrency, async (embedBatch) => {
            const vectors = await options.embed(embedBatch.map((chunk) => chunk.content));
            if (vectors.length !== embedBatch.length) throw new Error(`embedder returned ${vectors.length} vectors for ${embedBatch.length} chunks`);
            const completedBatch = embedBatch.map((chunk, index) => {
              const embedding = vectors[index];
              if (!embedding) throw new Error(`embedder returned an invalid vector for chunk ${chunk.id}`);
              assertEmbeddingVector(embedding, dimensions);
              return { ...chunk, embedding: isL2Normalized(embedding) ? [...embedding] : l2Normalize(embedding) };
            });
            await options.target.upsertChunks(completedBatch);
            progress.embedded += completedBatch.length;
            report();
          });
        }
        const pendingIds = new Set(pending.map((chunk) => chunk.id));
        const reusable = targetChunks.filter((chunk) => !pendingIds.has(chunk.id));
        if (reusable.length > 0) {
          await options.target.upsertChunks(reusable);
          progress.reused += reusable.length;
          report();
        }
        progress.chunks += targetChunks.length;
        documentChunks += targetChunks.length;
        progress.phase = "chunks";
        report();
      };

      for await (const chunk of options.source.listChunks(dataset.id, document.id)) {
        if (typeof chunk.content !== "string") throw new RagflowApiError(`RAGFlow chunk ${chunk.id} has no text`);
        batch.push({ source: chunk, index: nextChunkIndex++ });
        if (batch.length >= importBatchSize) await flush();
      }
      await flush();
      const expectedDocumentChunks = expectedChunksByDocument.get(JSON.stringify([dataset.id, document.id]));
      if (expectedDocumentChunks !== undefined && documentChunks !== expectedDocumentChunks) {
        throw new RagflowApiError(`RAGFlow chunk count mismatch for ${document.id}: source reports ${expectedDocumentChunks}, imported ${documentChunks}`);
      }
      await options.target.markDocumentReady(options.companyId, documentId);
    }
  }

  progress.phase = "complete";
  if (progress.datasets !== sourceDatasetCount) {
    throw new RagflowApiError(`RAGFlow dataset count mismatch: source listed ${sourceDatasetCount}, imported ${progress.datasets}`);
  }
  if (progress.documents !== sourceDocumentCount) {
    throw new RagflowApiError(`RAGFlow document count mismatch: source listed ${sourceDocumentCount}, imported ${progress.documents}`);
  }
  if (sourceChunkCount > 0 && (progress.chunks < sourceMinimumChunks || progress.chunks > sourceMaximumChunks)) {
    throw new RagflowApiError(`RAGFlow corpus chunk count mismatch: source lists ${sourceChunkCount} ±${tolerance * 100}%, imported ${progress.chunks}`);
  }
  report();
  return { datasets: progress.datasets, documents: progress.documents, chunks: progress.chunks, embedded: progress.embedded, reused: progress.reused, durationMs: Date.now() - startedAt };
}

function sourceCount(...values: unknown[]): number | undefined {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RagflowApiError("RAGFlow source reported an invalid document/chunk count");
  }
  return value;
}
function isReusableEmbedding(vector: number[], dimensions: number): boolean {
  try {
    assertEmbeddingVector(vector, dimensions);
    return isL2Normalized(vector);
  } catch {
    return false;
  }
}

function stableUuid(kind: string, value: string): string {
  const bytes = createHash("sha256").update(`myrmidon-ragflow-import:${kind}:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mimeTypeFromName(name: string, type: unknown): string | null {
  if (typeof type === "string" && type.includes("/")) return type;
  const extension = name.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = { pdf: "application/pdf", txt: "text/plain", md: "text/markdown", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", html: "text/html", csv: "text/csv" };
  return extension ? types[extension] ?? null : null;
}

function splitEvery<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

async function mapWithConcurrency<T, U>(values: T[], concurrency: number, run: (value: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await run(values[index]!);
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}
