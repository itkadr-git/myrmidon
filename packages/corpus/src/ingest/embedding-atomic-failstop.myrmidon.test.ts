import { describe, expect, it } from "vitest";
import type { Embedder, ReplaceCorpusChunksInput } from "../ports.js";
import { EmbeddingVectorError } from "../search/vector.js";
import { createDocumentIngestionPipeline, EmbeddingBatchError } from "./embedding-pipeline.js";

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
const documentId = "cccccccc-0000-0000-0000-000000000003";
const text = Array.from({ length: 5 }, (_, index) => `${index}${"x".repeat(599)}`).join("\n");
const request = { companyId, datasetId, documentId, text };
const options = {
  batchSize: 2,
  dimensions: 4,
  retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
  retryContext: { sleep: async () => {}, random: () => 0 },
  chunking: { maxChars: 1000, minChars: 300, overlapChars: 150 },
};

describe("ingestion atomic failstop", () => {
  const permanent = Object.assign(new Error("permanent gateway failure"), { retryable: false });
  const transient = Object.assign(new Error("exhausted gateway failure"), { retryable: true });
  const cases = [
    { name: "permanent rejection", error: permanent, calls: 2 },
    { name: "exhausted retry", error: transient, calls: 4 },
    { name: "count mismatch", vectors: [[1, 0, 0, 0]], code: "count-mismatch", message: "embedder returned 1 vectors for 2 texts", calls: 2 },
    { name: "wrong dimension", vectors: [[1, 0, 0], [1, 0, 0, 0]], code: "dimension", message: "embedding vector has 3 dimensions, expected 4", calls: 2 },
    { name: "NaN", vectors: [[NaN, 0, 0, 0], [1, 0, 0, 0]], code: "value", message: "embedding vector contains a non-finite number", calls: 2 },
    { name: "Infinity", vectors: [[Infinity, 0, 0, 0], [1, 0, 0, 0]], code: "value", message: "embedding vector contains a non-finite number", calls: 2 },
    { name: "zero vector", vectors: [[0, 0, 0, 0], [1, 0, 0, 0]], code: "value", message: "embedding vector has zero norm", calls: 2 },
  ];

  it.each(cases)("preserves stored chunks after a later $name", async (scenario) => {
    const calls: string[][] = [];
    const writes: ReplaceCorpusChunksInput[] = [];
    const stored = ["previously stored chunk"];
    const embedder: Embedder = {
      async embed({ texts }) {
        calls.push([...texts]);
        if (calls.length > 1 && scenario.error) throw scenario.error;
        return { model: "test", dimensions: 4, embeddings: calls.length === 1 ? texts.map(() => [1, 0, 0, 0]) : scenario.vectors ?? [] };
      },
    };
    const writer = { async replaceDocumentChunks(input: ReplaceCorpusChunksInput) { writes.push(input); stored.splice(0, stored.length, ...input.chunks.map((chunk) => chunk.content)); } };
    const failure: unknown = await createDocumentIngestionPipeline(options).ingest(request, { embedder, writer }).catch((error: unknown) => error);

    if (scenario.error) expect(failure).toBe(scenario.error);
    else {
      expect(failure).toBeInstanceOf(scenario.code === "count-mismatch" ? EmbeddingBatchError : EmbeddingVectorError);
      expect(failure).toMatchObject({ code: scenario.code, message: scenario.message });
    }
    expect(calls).toHaveLength(scenario.calls);
    expect(calls[0]).toHaveLength(2);
    expect(calls[1]).toHaveLength(2);
    for (const retry of calls.slice(2)) expect(retry).toEqual(calls[1]);
    expect(writes).toEqual([]);
    expect(stored).toEqual(["previously stored chunk"]);
  });

  it("propagates writer rejection once after all batches", async () => {
    const calls: string[][] = [];
    const writes: ReplaceCorpusChunksInput[] = [];
    const failure = new Error("writer rejected replacement");
    const embedder: Embedder = { async embed({ texts }) { calls.push([...texts]); return { model: "test", dimensions: 4, embeddings: texts.map(() => [1, 0, 0, 0]) }; } };
    const writer = { async replaceDocumentChunks(input: ReplaceCorpusChunksInput) { writes.push(input); throw failure; } };

    await expect(createDocumentIngestionPipeline(options).ingest(request, { embedder, writer })).rejects.toBe(failure);
    expect(calls.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(writes).toHaveLength(1);
    expect(writes[0].companyId).toBe(companyId);
    expect(writes[0].documentId).toBe(documentId);
    expect(writes[0].chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2, 3, 4]);
  });
});
