import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  RagflowApiError,
  stableUuid,
  type ChunkState,
  type CorpusImportTarget,
  type RagflowChunk,
  type RagflowDataset,
  type RagflowDocument,
  type RagflowSource,
} from "./ragflow.js";
import { dryRunRagflowImport } from "./ragflow-dry-run.js";

function makeNormalizedVector(dim: number): number[] {
  const v = new Array(dim).fill(1 / Math.sqrt(dim));
  return v;
}

function makeMockSource(params: {
  datasets: RagflowDataset[];
  documents: Map<string, RagflowDocument[]>;
  chunks: Map<string, RagflowChunk[]>;
}): RagflowSource {
  return {
    baseUrl: "https://ragflow.mock",
    apiKey: "mock-key",
    pageSize: 10,
    async listDatasets() { return params.datasets; },
    async *listDocuments(datasetId: string) {
      for (const doc of params.documents.get(datasetId) ?? []) yield doc;
    },
    async *listChunks(datasetId: string, documentId: string) {
      for (const ch of params.chunks.get(`${datasetId}:${documentId}`) ?? []) yield ch;
    },
  };
}

describe("dryRunRagflowImport", () => {
  it("performs read-only inventory of datasets, documents, and chunks with zero coverage when db is empty", async () => {
    const dataset: RagflowDataset = { id: "ds-1", name: "Knowledge Base", chunk_count: 2, document_count: 1 };
    const doc: RagflowDocument = { id: "doc-1", name: "guide.md", chunk_count: 2, run: "DONE" };
    const chunk1: RagflowChunk = { id: "c-1", content: "first section" };
    const chunk2: RagflowChunk = { id: "c-2", content: "second section" };

    const source = makeMockSource({
      datasets: [dataset],
      documents: new Map([["ds-1", [doc]]]),
      chunks: new Map([["ds-1:doc-1", [chunk1, chunk2]]]),
    });

    const target: Pick<CorpusImportTarget, "getChunkStates"> = {
      async getChunkStates() {
        return new Map<string, ChunkState>();
      },
    };

    const result = await dryRunRagflowImport({
      source,
      target,
      companyId: "comp-123",
      embeddingModel: DEFAULT_EMBEDDING_MODEL,
      embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    });

    expect(result.datasets).toBe(1);
    expect(result.documents).toBe(1);
    expect(result.chunks).toBe(2);
    expect(result.coverage.reusableChunks).toBe(0);
    expect(result.coverage.missingChunks).toBe(2);
    expect(result.coverage.coverageRatio).toBe(0);
    expect(result.details.datasets[0]?.name).toBe("Knowledge Base");
    expect(result.details.datasets[0]?.documentsList[0]?.name).toBe("guide.md");
  });

  it("accurately detects existing matching embeddings and computes coverage ratio", async () => {
    const companyId = "comp-456";
    const dataset: RagflowDataset = { id: "ds-2", name: "API Docs", chunk_count: 2, document_count: 1 };
    const doc: RagflowDocument = { id: "doc-2", name: "reference.md", chunk_count: 2, run: "DONE" };
    const chunk1: RagflowChunk = { id: "c-1", content: "intro chunk" };
    const chunk2: RagflowChunk = { id: "c-2", content: "unembedded chunk" };

    const source = makeMockSource({
      datasets: [dataset],
      documents: new Map([["ds-2", [doc]]]),
      chunks: new Map([["ds-2:doc-2", [chunk1, chunk2]]]),
    });

    const chunk1Id = stableUuid("chunk", JSON.stringify([companyId, "ds-2", "doc-2", "c-1"]));
    const contentHash = createHash("sha256").update(chunk1.content).digest("hex");
    const validVector = makeNormalizedVector(DEFAULT_EMBEDDING_DIMENSIONS);

    const states = new Map<string, ChunkState>([
      [
        chunk1Id,
        {
          content: chunk1.content,
          embedding: validVector,
          embeddingModel: DEFAULT_EMBEDDING_MODEL,
          embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
          embeddingContentHash: contentHash,
        },
      ],
    ]);

    const target: Pick<CorpusImportTarget, "getChunkStates"> = {
      async getChunkStates(_companyId, ids) {
        const res = new Map<string, ChunkState>();
        for (const id of ids) {
          const s = states.get(id);
          if (s) res.set(id, s);
        }
        return res;
      },
    };

    const result = await dryRunRagflowImport({
      source,
      target,
      companyId,
      embeddingModel: DEFAULT_EMBEDDING_MODEL,
      embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    });

    expect(result.chunks).toBe(2);
    expect(result.coverage.reusableChunks).toBe(1);
    expect(result.coverage.missingChunks).toBe(1);
    expect(result.coverage.coverageRatio).toBe(0.5);
  });

  it("permits zero-chunk documents with non-DONE run states", async () => {
    const dataset: RagflowDataset = { id: "ds-empty", name: "Empty KB", chunk_count: 0, document_count: 1 };
    const doc: RagflowDocument = { id: "doc-empty", name: "empty.txt", chunk_count: 0, run: "PENDING" };

    const source = makeMockSource({
      datasets: [dataset],
      documents: new Map([["ds-empty", [doc]]]),
      chunks: new Map([["ds-empty:doc-empty", []]]),
    });

    const target: Pick<CorpusImportTarget, "getChunkStates"> = {
      async getChunkStates() {
        return new Map<string, ChunkState>();
      },
    };

    const result = await dryRunRagflowImport({
      source,
      target,
      companyId: "comp-zero",
      embeddingModel: DEFAULT_EMBEDDING_MODEL,
      embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    });

    expect(result.datasets).toBe(1);
    expect(result.documents).toBe(1);
    expect(result.chunks).toBe(0);
    expect(result.coverage.reusableChunks).toBe(0);
    expect(result.coverage.missingChunks).toBe(0);
    expect(result.coverage.coverageRatio).toBe(1.0);
  });

  it("rejects documents with expected chunks and non-DONE run states", async () => {
    const dataset: RagflowDataset = { id: "ds-err", name: "Err KB", chunk_count: 1, document_count: 1 };
    const doc: RagflowDocument = { id: "doc-err", name: "pending.txt", chunk_count: 1, run: "RUNNING" };
    const chunk: RagflowChunk = { id: "c-err", content: "some text" };

    const source = makeMockSource({
      datasets: [dataset],
      documents: new Map([["ds-err", [doc]]]),
      chunks: new Map([["ds-err:doc-err", [chunk]]]),
    });

    const target: Pick<CorpusImportTarget, "getChunkStates"> = {
      async getChunkStates() {
        return new Map<string, ChunkState>();
      },
    };

    await expect(
      dryRunRagflowImport({
        source,
        target,
        companyId: "comp-err",
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
        embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      }),
    ).rejects.toThrow(RagflowApiError);
  });

  it("throws when total enumerated chunks fall outside configured tolerance", async () => {
    const dataset: RagflowDataset = { id: "ds-tol", name: "Tol KB", chunk_count: 10, document_count: 1 };
    const doc: RagflowDocument = { id: "doc-tol", name: "tol.txt", chunk_count: 10, run: "DONE" };
    // Only 5 chunks enumerated instead of 10
    const chunks: RagflowChunk[] = Array.from({ length: 5 }, (_, i) => ({ id: `c-${i}`, content: `text ${i}` }));

    const source = makeMockSource({
      datasets: [dataset],
      documents: new Map([["ds-tol", [doc]]]),
      chunks: new Map([["ds-tol:doc-tol", chunks]]),
    });

    const target: Pick<CorpusImportTarget, "getChunkStates"> = {
      async getChunkStates() {
        return new Map<string, ChunkState>();
      },
    };

    await expect(
      dryRunRagflowImport({
        source,
        target,
        companyId: "comp-tol",
        chunkCountTolerance: 0.1, // 10% tolerance, but 5/10 is 50% discrepancy
      }),
    ).rejects.toThrow(RagflowApiError);
  });
});
