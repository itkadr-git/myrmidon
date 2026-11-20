import { describe, expect, it, vi } from "vitest";
import { dryRunRagflowImport } from "./ragflow-dry-run.js";
import { RagflowApiError, type ChunkState, type RagflowSource } from "./ragflow.js";

function fixture(documentCount: number, endpointCount: number, datasetCount: number, run = "DONE") {
  const listChunks = vi.fn(async function* () {
    for (let i = 0; i < endpointCount; i++) yield { id: `c-${i}`, content: `chunk ${i}` };
  });
  const source: RagflowSource = {
    baseUrl: "https://ragflow.mock",
    async listDatasets() { return [{ id: "ds", name: "Dataset", document_count: 1, chunk_count: datasetCount }]; },
    async *listDocuments() { yield { id: "doc", name: "Document", chunk_count: documentCount, run }; },
    async countChunks() { return endpointCount; },
    listChunks,
  };
  const getChunkStates = vi.fn(async () => new Map<string, ChunkState>());
  return { source, target: { getChunkStates }, listChunks, getChunkStates };
}

describe("dryRunRagflowImport count and readiness gates", () => {
  it.each([9, 10, 11])("accepts document count %i within the inclusive tolerance", async (endpointCount) => {
    const f = fixture(10, endpointCount, endpointCount);
    const result = await dryRunRagflowImport({ ...f, companyId: "company", chunkCountTolerance: 0.1 });
    expect(result).toMatchObject({ datasets: 1, documents: 1, chunks: endpointCount, coverage: { reusableChunks: 0, missingChunks: endpointCount, coverageRatio: 0 } });
    expect(result.details.datasets[0]?.documentsList[0]).toMatchObject({ expectedChunks: endpointCount, listedChunks: endpointCount });
    expect(f.getChunkStates).toHaveBeenCalledTimes(1);
  });

  it.each([8, 12])("rejects document endpoint count %i outside tolerance", async (endpointCount) => {
    const f = fixture(10, endpointCount, endpointCount);
    await expect(dryRunRagflowImport({ ...f, companyId: "company", chunkCountTolerance: 0.1 }))
      .rejects.toThrow(new RagflowApiError(`RAGFlow chunk count mismatch for doc: document reports 10, source endpoint reports ${endpointCount}`));
    expect(f.listChunks).not.toHaveBeenCalled();
    expect(f.getChunkStates).not.toHaveBeenCalled();
  });

  it.each([9, 10, 11])("accepts dataset document total %i within the inclusive tolerance", async (endpointCount) => {
    const f = fixture(endpointCount, endpointCount, 10);
    const result = await dryRunRagflowImport({ ...f, companyId: "company", chunkCountTolerance: 0.1 });
    expect(result).toMatchObject({ datasets: 1, documents: 1, chunks: endpointCount, coverage: { reusableChunks: 0, missingChunks: endpointCount, coverageRatio: 0 } });
    expect(result.details.datasets[0]).toMatchObject({ expectedChunks: endpointCount, listedChunks: endpointCount });
    expect(f.getChunkStates).toHaveBeenCalledTimes(1);
  });

  it.each([8, 12])("rejects dataset document total %i outside tolerance", async (endpointCount) => {
    const f = fixture(endpointCount, endpointCount, 10);
    await expect(dryRunRagflowImport({ ...f, companyId: "company", chunkCountTolerance: 0.1 }))
      .rejects.toThrow(new RagflowApiError(`RAGFlow chunk count mismatch for dataset ds: source reports 10, listed documents report ${endpointCount}`));
    expect(f.listChunks).not.toHaveBeenCalled();
    expect(f.getChunkStates).not.toHaveBeenCalled();
  });

  it("rejects a non-ready document with expected chunks before reading states", async () => {
    const f = fixture(1, 1, 1, "RUNNING");
    await expect(dryRunRagflowImport({ ...f, companyId: "company" }))
      .rejects.toThrow(new RagflowApiError("RAGFlow document doc is not ready (run=RUNNING)"));
    expect(f.listChunks).not.toHaveBeenCalled();
    expect(f.getChunkStates).not.toHaveBeenCalled();
  });
});
