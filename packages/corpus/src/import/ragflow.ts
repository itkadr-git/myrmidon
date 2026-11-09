import { createHash } from "node:crypto";
import { assertEmbeddingVector, isL2Normalized, l2Normalize } from "../search/vector.js";

// myrmidon(OPE-10668): RAGFlow rejects page_size > 100 with error 101
// ("page_size must be less than or equal to 100").
export const DEFAULT_RAGFLOW_PAGE_SIZE = 100;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 64;
export const DEFAULT_EMBEDDING_CONCURRENCY = 4;
export const DEFAULT_EMBEDDING_MODEL = "corpus-embed-pplx-0.6b";
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
  /** Optional original-file retrieval for unparsed documents. */
  downloadDocument?(datasetId: string, documentId: string): Promise<{ bytes: Uint8Array; filename: string; mimeType?: string | null }>;
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

export type ChunkState = {
  content: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingContentHash: string | null;
};

export type CorpusImportTarget = {
  upsertDataset(dataset: CorpusImportDataset): Promise<void>;
  upsertDocument(document: CorpusImportDocument): Promise<void>;
  getChunkStates(companyId: string, ids: string[]): Promise<Map<string, ChunkState>>;
  upsertChunks(chunks: CorpusImportChunk[]): Promise<void>;
  markDocumentReady(companyId: string, documentId: string): Promise<void>;
  uploadDocument?(input: { companyId: string; datasetId: string; filename: string; mimeType: string | null; bytes: Uint8Array }): Promise<void>;
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
  /** myrmidon(OPE-10668): when set, only datasets whose name is in this list are imported. */
  datasetNames?: readonly string[];
  uploadUnparsed?: boolean;
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
  /** A document failed after producing some chunks. */
  partial?: boolean;
  /** Document IDs that have no parsed chunks and were not imported. */
  notParsed?: CorpusImportNotParsed[];
};

export type CorpusImportNotParsed = {
  id: string;
  name: string;
  run: string;
  size: number | null;
};

export type CorpusImportSummary = {
  datasets: number;
  documents: number;
  chunks: number;
  embedded: number;
  reused: number;
  partial?: string[];
  notParsed: CorpusImportNotParsed[];
  durationMs: number;
};

export class RagflowApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "RagflowApiError";
  }
}

/** A source read stopped before the dataset was fully inspected or imported. */
export class RagflowDatasetReadError extends RagflowApiError {
  readonly exitCode = 2;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "RagflowDatasetReadError";
  }
}

export function getRagflowImportExitCode(error: unknown): number {
  if (error instanceof RagflowDatasetReadError) return error.exitCode;
  return 1;
}

function toDatasetReadError(error: unknown): RagflowDatasetReadError {
  if (error instanceof RagflowDatasetReadError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RagflowDatasetReadError(`RAGFlow dataset could not be read: ${message}`, error);
}

async function readSource<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw toDatasetReadError(error);
  }
}

async function* readSourceItems<T>(items: AsyncIterable<T>): AsyncIterable<T> {
  try {
    for await (const item of items) yield item;
  } catch (error) {
    throw toDatasetReadError(error);
  }
}

async function collectSource<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  try {
    for await (const item of items) values.push(item);
  } catch (error) {
    throw toDatasetReadError(error);
  }
  return values;
}

/**
 * myrmidon(OPE-10668): RAGFlow document metadata and chunk text can carry raw
 * NUL characters (U+0000). PostgreSQL rejects them in text/jsonb values with
 * "unsupported Unicode escape sequence" / "invalid byte sequence", so every
 * string that reaches corpus_documents / corpus_chunks must pass through here
 * before it is written or hashed. NULs are removed, not replaced: they carry
 * no information in extracted text and a replacement char would churn the
 * embedding-content hash.
 */
const NUL_CHARACTER = "\u0000";

export function sanitizeNulText(value: string): string {
  return value.includes(NUL_CHARACTER) ? value.replaceAll(NUL_CHARACTER, "") : value;
}

/**
 * myrmidon(OPE-10668): deep-copy a JSON-shaped value while stripping NULs from
 * every string. Document/chunk metadata from RAGFlow is arbitrary JSON.
 */
export function sanitizeNulJson(value: unknown): unknown {
  if (typeof value === "string") return sanitizeNulText(value);
  if (Array.isArray(value)) return value.map(sanitizeNulJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = sanitizeNulJson(entry);
    return out;
  }
  return value;
}

/** myrmidon(OPE-10668): declared vs observed counts may drift slightly on a
 * live RAGFlow instance (document reports 1020 chunks, endpoint enumerates
 * 1019). The importer tolerates a per-document relative drift instead of
 * aborting the whole run. */
export function isWithinChunkTolerance(expected: number, actual: number, tolerance: number): boolean {
  const minimum = Math.floor(expected * (1 - tolerance));
  const maximum = Math.ceil(expected * (1 + tolerance));
  return actual >= minimum && actual <= maximum;
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
    async downloadDocument(datasetId, documentId) {
      const response = await fetchImpl(`${baseUrl}/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/download`, {
        headers: { authorization: `Bearer ${options.apiKey}` },
      });
      if (!response.ok) throw new RagflowApiError(`RAGFlow document download failed (${response.status})`, response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentDisposition = response.headers.get("content-disposition") ?? "";
      const filename = contentDisposition.match(/filename="?([^";]+)"?/i)?.[1] ?? documentId;
      return { bytes, filename, mimeType: response.headers.get("content-type") };
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

  const progress: CorpusImportProgress = { phase: "dataset", datasets: 0, documents: 0, chunks: 0, embedded: 0, reused: 0, notParsed: [] };
  const partialDocuments: string[] = [];
  const report = () => options.onProgress?.({ ...progress });
  const datasets = (await readSource(() => options.source.listDatasets())).filter((dataset) => {
    if (!options.datasetNames || options.datasetNames.length === 0) return true;
    return options.datasetNames.includes(dataset.name ?? "");
  });
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
    const documents = await collectSource(options.source.listDocuments(dataset.id));
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
        ? sourceCount(await readSource(() => options.source.countChunks!(dataset.id, document.id)))
        : undefined;
      // myrmidon(OPE-10668): a live RAGFlow instance can report a per-document
      // chunk total one off from what the endpoint enumerates (1020 declared
      // vs 1019 listed). Apply the configured tolerance instead of aborting.
      if (declaredChunks !== undefined && sourceChunkCount !== undefined
        && !isWithinChunkTolerance(declaredChunks, sourceChunkCount, tolerance)) {
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
    // myrmidon(OPE-10668): the dataset total can drift the same way as the
    // per-document totals on a live instance; apply the tolerance here too.
    if (declaredChunks !== undefined && !isWithinChunkTolerance(declaredChunks, datasetChunks, tolerance)) {
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
      const expectedChunks = expectedChunksByDocument.get(JSON.stringify([dataset.id, document.id])) ?? 0;
      const runState = document.run === undefined || document.run === null ? "" : String(document.run).toUpperCase();
      const isReady = ["DONE", "3"].includes(runState);
      const hasChunks = expectedChunks > 0;
      const isUnparsedNonReady = !hasChunks && (
        !isReady && (["CANCEL", "FAIL", "UNSTART", "UNSTARTED", "FAILED", "CANCELED", "4", "0"].includes(runState) || runState === "")
      );
      if (isUnparsedNonReady) {
        const notParsed = { id: document.id, name: document.name ?? document.location ?? document.id, run: runState || "UNKNOWN", size: safeInteger(document.size) };
        progress.notParsed!.push(notParsed);
        progress.documentId = document.id;
        report();
        if (options.uploadUnparsed && options.source.downloadDocument && options.target.uploadDocument) {
          const file = await options.source.downloadDocument(dataset.id, document.id);
          await options.target.uploadDocument({ companyId: options.companyId, datasetId, filename: file.filename, mimeType: file.mimeType ?? mimeTypeFromName(file.filename, document.type), bytes: file.bytes });
        }
        continue;
      }
      if (!isReady && hasChunks) {
        partialDocuments.push(document.id);
        progress.documentId = document.id;
        progress.partial = true;
        report();
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
        metadata: sanitizeNulJson({
          ragflowDatasetId: dataset.id,
          ragflowDocumentId: document.id,
          ragflow: document,
        }) as Record<string, unknown>,
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
          // myrmidon(OPE-10668): strip NULs before the value reaches Postgres or
          // the embedding-content hash; a drift between stored content and the
          // hash would defeat embedding reuse.
          content: sanitizeNulText(source.content),
          embedding: null as number[] | null,
          metadata: sanitizeNulJson({
            ragflowDatasetId: dataset.id,
            ragflowDocumentId: document.id,
            ragflowChunkId: source.id || null,
            embeddingContentHash: createHash("sha256").update(sanitizeNulText(source.content)).digest("hex"),
            embeddingModel,
            embeddingDimensions: dimensions,
            positions: source.positions ?? [],
            importantKeywords: source.important_keywords ?? [],
          }) as Record<string, unknown>,
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

      for await (const chunk of readSourceItems(options.source.listChunks(dataset.id, document.id))) {
        if (typeof chunk.content !== "string") throw new RagflowApiError(`RAGFlow chunk ${chunk.id} has no text`);
        batch.push({ source: chunk, index: nextChunkIndex++ });
        if (batch.length >= importBatchSize) await flush();
      }
      await flush();
      const expectedDocumentChunks = expectedChunksByDocument.get(JSON.stringify([dataset.id, document.id]));
      // myrmidon(OPE-10668): apply the same tolerance as the preflight checks.
      if (expectedDocumentChunks !== undefined && isReady && !isWithinChunkTolerance(expectedDocumentChunks, documentChunks, tolerance)) {
        throw new RagflowApiError(`RAGFlow chunk count mismatch for ${document.id}: source reports ${expectedDocumentChunks}, imported ${documentChunks}`);
      }
      await options.target.markDocumentReady(options.companyId, documentId);
    }
  }

  progress.phase = "complete";
  if (progress.datasets !== sourceDatasetCount) {
    throw new RagflowDatasetReadError(`RAGFlow dataset count mismatch: source listed ${sourceDatasetCount}, imported ${progress.datasets}`);
  }
  if (progress.documents + progress.notParsed!.length !== sourceDocumentCount) {
    throw new RagflowDatasetReadError(`RAGFlow document count mismatch: source listed ${sourceDocumentCount}, imported ${progress.documents}`);
  }
  if (sourceChunkCount > 0 && progress.notParsed!.length === 0 && partialDocuments.length === 0 && (progress.chunks < sourceMinimumChunks || progress.chunks > sourceMaximumChunks)) {
    throw new RagflowDatasetReadError(`RAGFlow corpus chunk count mismatch: source lists ${sourceChunkCount} ±${tolerance * 100}%, imported ${progress.chunks}`);
  }
  report();
  return { datasets: progress.datasets, documents: progress.documents, chunks: progress.chunks, embedded: progress.embedded, reused: progress.reused, partial: partialDocuments.length > 0 ? partialDocuments : undefined, notParsed: progress.notParsed ?? [], durationMs: Date.now() - startedAt };
}

function sourceCount(...values: unknown[]): number | undefined {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RagflowApiError("RAGFlow source reported an invalid document/chunk count");
  }
  return value;
}
export function isReusableEmbedding(vector: number[], dimensions: number): boolean {
  try {
    assertEmbeddingVector(vector, dimensions);
    return isL2Normalized(vector);
  } catch {
    return false;
  }
}

export function stableUuid(kind: string, value: string): string {
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
