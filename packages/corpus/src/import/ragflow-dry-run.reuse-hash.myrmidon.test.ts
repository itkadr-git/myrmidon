import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  stableUuid,
  type ChunkState,
  type RagflowSource,
} from "./ragflow.js";
import { dryRunRagflowImport } from "./ragflow-dry-run.js";

const companyId = "company-1";
const content = "current chunk content";
const contentHash = createHash("sha256").update(content).digest("hex");
const chunkId = stableUuid("chunk", JSON.stringify([companyId, "dataset-1", "document-1", "chunk-1"]));

async function inventory(overrides: Partial<ChunkState>) {
  const listDatasets = vi.fn(async () => [{ id: "dataset-1", name: "Docs", document_count: 1, chunk_count: 1 }]);
  const listDocuments = vi.fn(async function* () {
    yield { id: "document-1", name: "guide.md", chunk_count: 1, run: "DONE" };
  });
  const listChunks = vi.fn(async function* () {
    yield { id: "chunk-1", content };
  });
  const source: RagflowSource = { baseUrl: "https://ragflow.mock", listDatasets, listDocuments, listChunks };
  const state: ChunkState = {
    content,
    embedding: Array(DEFAULT_EMBEDDING_DIMENSIONS).fill(1 / Math.sqrt(DEFAULT_EMBEDDING_DIMENSIONS)),
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    embeddingContentHash: contentHash,
    ...overrides,
  };
  const getChunkStates = vi.fn(async () => new Map([[chunkId, state]]));
  const result = await dryRunRagflowImport({ source, target: { getChunkStates }, companyId });

  expect(listDatasets).toHaveBeenCalledOnce();
  expect(listDocuments).toHaveBeenCalledExactlyOnceWith("dataset-1");
  expect(listChunks).toHaveBeenCalledExactlyOnceWith("dataset-1", "document-1");
  expect(getChunkStates).toHaveBeenCalledExactlyOnceWith(companyId, [chunkId]);
  expect(result.chunks).toBe(1);
  return result;
}

describe("dryRunRagflowImport embedding content identity", () => {
  it.each([
    ["a stale hash with matching content", { embeddingContentHash: createHash("sha256").update("old content").digest("hex") }],
    ["stale content with a matching hash", { content: "old content" }],
  ])("rejects %s despite a valid embedding", async (_name, overrides) => {
    const result = await inventory(overrides);
    expect(result.coverage).toEqual({ reusableChunks: 0, missingChunks: 1, coverageRatio: 0 });
    expect(result.details.datasets[0]).toMatchObject({ reusableChunks: 0, missingChunks: 1 });
    expect(result.details.datasets[0]?.documentsList[0]).toMatchObject({ reusableChunks: 0, missingChunks: 1 });
  });

  it("reuses an embedding only when both hash and content match", async () => {
    const result = await inventory({});
    expect(result.coverage).toEqual({ reusableChunks: 1, missingChunks: 0, coverageRatio: 1 });
    expect(result.details.datasets[0]).toMatchObject({ reusableChunks: 1, missingChunks: 0 });
    expect(result.details.datasets[0]?.documentsList[0]).toMatchObject({ reusableChunks: 1, missingChunks: 0 });
  });
});
