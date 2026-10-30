import { createHash } from "node:crypto";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  RagflowApiError,
  isReusableEmbedding,
  stableUuid,
  type RagflowChunk,
  type RagflowDocument,
  type RagflowSource,
  type CorpusImportTarget,
} from "./ragflow.js";

export interface RagflowDryRunOptions {
  source: RagflowSource;
  target: Pick<CorpusImportTarget, "getChunkStates">;
  companyId: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  chunkCountTolerance?: number;
  onProgress?: (progress: RagflowDryRunProgress) => void;
}

export interface RagflowDryRunDocumentDetail {
  id: string;
  datasetId: string;
  name: string;
  runState: string;
  expectedChunks: number;
  listedChunks: number;
  reusableChunks: number;
  missingChunks: number;
}

export interface RagflowDryRunDatasetDetail {
  id: string;
  name: string;
  documents: number;
  expectedChunks: number;
  listedChunks: number;
  reusableChunks: number;
  missingChunks: number;
  documentsList: RagflowDryRunDocumentDetail[];
}

export interface RagflowDryRunCoverage {
  reusableChunks: number;
  missingChunks: number;
  coverageRatio: number;
}

export interface RagflowDryRunResult {
  companyId: string;
  embeddingModel: string;
  embeddingDimensions: number;
  datasets: number;
  documents: number;
  chunks: number;
  coverage: RagflowDryRunCoverage;
  details: {
    datasets: RagflowDryRunDatasetDetail[];
  };
}

export interface RagflowDryRunProgress {
  phase: "init" | "dataset" | "document" | "chunk" | "complete";
  datasets: number;
  documents: number;
  chunks: number;
  reusableChunks: number;
  missingChunks: number;
  datasetId?: string;
  documentId?: string;
}

function sourceCount(...values: Array<number | string | undefined | null>): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

export async function dryRunRagflowImport(options: RagflowDryRunOptions): Promise<RagflowDryRunResult> {
  if (!options.companyId) {
    throw new Error("companyId is required for dry-run");
  }

  const embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const dimensions = options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const tolerance = Math.max(0, options.chunkCountTolerance ?? 0);

  const progress: RagflowDryRunProgress = {
    phase: "init",
    datasets: 0,
    documents: 0,
    chunks: 0,
    reusableChunks: 0,
    missingChunks: 0,
  };

  const report = () => options.onProgress?.({ ...progress });
  report();

  const datasets: Array<{ id: string; name: string; description?: string | null; document_count?: number; doc_num?: number; chunk_count?: number; chunk_num?: number }> = [];
  for await (const dataset of options.source.listDatasets()) {
    datasets.push(dataset);
  }

  const documentsByDataset = new Map<string, RagflowDocument[]>();
  const expectedChunksByDocument = new Map<string, number>();
  let sourceDocumentCount = 0;
  let sourceChunkCount = 0;

  for (const dataset of datasets) {
    if (!dataset.id || !dataset.name) {
      throw new RagflowApiError("RAGFlow dataset is missing id or name");
    }

    const documents: RagflowDocument[] = [];
    for await (const document of options.source.listDocuments(dataset.id)) {
      documents.push(document);
    }
    documentsByDataset.set(dataset.id, documents);
    sourceDocumentCount += documents.length;

    const declaredDocuments = sourceCount(dataset.document_count, dataset.doc_num);
    if (declaredDocuments !== undefined && declaredDocuments !== documents.length) {
      throw new RagflowApiError(
        `RAGFlow document count mismatch for dataset ${dataset.id}: source reports ${declaredDocuments}, listed ${documents.length}`,
      );
    }

    let datasetChunks = 0;
    for (const document of documents) {
      if (!document.id) {
        throw new RagflowApiError(`RAGFlow document in dataset ${dataset.id} is missing an id`);
      }
      const declaredChunks = sourceCount(document.chunk_count, document.chunk_num);
      const endpointChunkCount = options.source.countChunks
        ? sourceCount(await options.source.countChunks(dataset.id, document.id))
        : undefined;
      if (declaredChunks !== undefined && endpointChunkCount !== undefined && declaredChunks !== endpointChunkCount) {
        throw new RagflowApiError(
          `RAGFlow chunk count mismatch for ${document.id}: document reports ${declaredChunks}, source endpoint reports ${endpointChunkCount}`,
        );
      }
      const expectedChunks = endpointChunkCount ?? declaredChunks;
      if (expectedChunks === undefined) {
        throw new RagflowApiError(`RAGFlow provides no source chunk total for ${document.id}; cannot preflight`);
      }
      expectedChunksByDocument.set(JSON.stringify([dataset.id, document.id]), expectedChunks);
      datasetChunks += expectedChunks;
    }

    const declaredChunks = sourceCount(dataset.chunk_count, dataset.chunk_num);
    if (declaredChunks !== undefined && declaredChunks !== datasetChunks) {
      throw new RagflowApiError(
        `RAGFlow chunk count mismatch for dataset ${dataset.id}: source reports ${declaredChunks}, listed documents report ${datasetChunks}`,
      );
    }
    sourceChunkCount += datasetChunks;
  }

  const datasetDetails: RagflowDryRunDatasetDetail[] = [];
  let totalReusableChunks = 0;
  let totalMissingChunks = 0;
  let totalListedChunks = 0;

  for (const dataset of datasets) {
    progress.phase = "dataset";
    progress.datasetId = dataset.id;
    report();

    const documents = documentsByDataset.get(dataset.id) ?? [];
    const documentDetails: RagflowDryRunDocumentDetail[] = [];
    let datasetReusable = 0;
    let datasetMissing = 0;
    let datasetListed = 0;
    let datasetExpected = 0;

    for (const document of documents) {
      progress.phase = "document";
      progress.documentId = document.id;
      report();

      const expectedChunks = expectedChunksByDocument.get(JSON.stringify([dataset.id, document.id])) ?? 0;
      datasetExpected += expectedChunks;

      const runState = document.run === undefined || document.run === null ? "" : String(document.run).toUpperCase();
      if (expectedChunks > 0 && !["DONE", "3"].includes(runState)) {
        throw new RagflowApiError(`RAGFlow document ${document.id} is not ready (run=${runState || "unknown"})`);
      }

      const chunks: RagflowChunk[] = [];
      for await (const chunk of options.source.listChunks(dataset.id, document.id)) {
        chunks.push(chunk);
      }

      datasetListed += chunks.length;
      totalListedChunks += chunks.length;

      // Group into batches to query chunk states efficiently
      const batchSize = 100;
      let docReusable = 0;
      let docMissing = 0;

      for (let i = 0; i < chunks.length; i += batchSize) {
        const chunkBatch = chunks.slice(i, i + batchSize);
        const chunkIds = chunkBatch.map((chunk, batchIdx) => {
          const globalIdx = i + batchIdx;
          return stableUuid("chunk", JSON.stringify([options.companyId, dataset.id, document.id, chunk.id || globalIdx]));
        });

        const states = await options.target.getChunkStates(options.companyId, chunkIds);
        const stateMap = states instanceof Map ? states : new Map((states as unknown as Array<{ id: string } & Record<string, unknown>>).map((s) => [s.id, s]));

        for (let j = 0; j < chunkBatch.length; j++) {
          const chunk = chunkBatch[j]!;
          const chunkId = chunkIds[j]!;
          const state = stateMap.get(chunkId);
          const contentHash = createHash("sha256").update(chunk.content).digest("hex");

          const isReusable =
            state != null &&
            state.embedding != null &&
            isReusableEmbedding(state.embedding, dimensions) &&
            state.embeddingModel === embeddingModel &&
            state.embeddingDimensions === dimensions &&
            state.embeddingContentHash === contentHash &&
            state.content === chunk.content;

          if (isReusable) {
            docReusable += 1;
            progress.reusableChunks += 1;
          } else {
            docMissing += 1;
            progress.missingChunks += 1;
          }
          progress.chunks += 1;
        }
        report();
      }

      datasetReusable += docReusable;
      datasetMissing += docMissing;
      totalReusableChunks += docReusable;
      totalMissingChunks += docMissing;

      documentDetails.push({
        id: document.id,
        datasetId: dataset.id,
        name: document.name ?? document.location ?? document.id,
        runState: runState || "UNKNOWN",
        expectedChunks,
        listedChunks: chunks.length,
        reusableChunks: docReusable,
        missingChunks: docMissing,
      });

      progress.documents += 1;
      report();
    }

    datasetDetails.push({
      id: dataset.id,
      name: dataset.name,
      documents: documents.length,
      expectedChunks: datasetExpected,
      listedChunks: datasetListed,
      reusableChunks: datasetReusable,
      missingChunks: datasetMissing,
      documentsList: documentDetails,
    });

    progress.datasets += 1;
    report();
  }

  const sourceMinimumChunks = Math.floor(sourceChunkCount * (1 - tolerance));
  const sourceMaximumChunks = Math.ceil(sourceChunkCount * (1 + tolerance));
  if (totalListedChunks < sourceMinimumChunks || totalListedChunks > sourceMaximumChunks) {
    throw new RagflowApiError(
      `RAGFlow total chunk count out of tolerance: expected ${sourceChunkCount} (range ${sourceMinimumChunks}..${sourceMaximumChunks}), enumerated ${totalListedChunks}`,
    );
  }

  progress.phase = "complete";
  report();

  const totalChunks = totalListedChunks;
  const coverageRatio = totalChunks > 0 ? totalReusableChunks / totalChunks : 1.0;

  return {
    companyId: options.companyId,
    embeddingModel,
    embeddingDimensions: dimensions,
    datasets: datasets.length,
    documents: sourceDocumentCount,
    chunks: totalChunks,
    coverage: {
      reusableChunks: totalReusableChunks,
      missingChunks: totalMissingChunks,
      coverageRatio,
    },
    details: {
      datasets: datasetDetails,
    },
  };
}
