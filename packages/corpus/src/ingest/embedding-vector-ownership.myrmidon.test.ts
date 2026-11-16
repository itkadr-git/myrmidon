import { describe, expect, it } from "vitest";
import type { Embedder } from "../ports.js";
import { createDocumentIngestionPipeline, type CorpusChunkDraft, type CorpusChunkWriter } from "./embedding-pipeline.js";

const request = Object.freeze({
  companyId: "aaaaaaaa-0000-0000-0000-000000000001",
  datasetId: "bbbbbbbb-0000-0000-0000-000000000002",
  documentId: "cccccccc-0000-0000-0000-000000000003",
  text: "A single document chunk for embedding.",
});

function setup(vector: number[], normalize?: boolean) {
  const textsSeen: string[][] = [];
  const drafts: CorpusChunkDraft[] = [];
  const embeddings = [vector];
  const embedder: Embedder = {
    async embed({ texts }) {
      textsSeen.push([...texts]);
      Object.freeze(texts);
      return { model: "fixture", dimensions: 4, embeddings };
    },
  };
  const writer: CorpusChunkWriter = {
    async replaceDocumentChunks(input) {
      drafts.push(...input.chunks);
    },
  };
  const pipeline = createDocumentIngestionPipeline({ dimensions: 4, normalize });
  return { embeddings, textsSeen, drafts, ingest: () => pipeline.ingest(request, { embedder, writer }) };
}

describe("ingestion embedding ownership", () => {
  const cases: Array<{ name: string; normalize?: boolean; vector: number[]; expected: number[] }> = [
    { name: "default scales positive vector", vector: [3, 4, 0, 0], expected: [0.6, 0.8, 0, 0] },
    { name: "default preserves unit negative vector", vector: [-1, 0, 0, 0], expected: [-1, 0, 0, 0] },
    { name: "default preserves near unit vector", vector: [1.0005, 0, 0, 0], expected: [1.0005, 0, 0, 0] },
    { name: "true scales negative components", normalize: true, vector: [-3, 4, 0, 0], expected: [-0.6, 0.8, 0, 0] },
    { name: "true preserves unit vector", normalize: true, vector: [0, 1, 0, 0], expected: [0, 1, 0, 0] },
    { name: "true preserves near unit vector", normalize: true, vector: [0, 0.9995, 0, 0], expected: [0, 0.9995, 0, 0] },
    { name: "false preserves non-unit vector", normalize: false, vector: [-3, 4, 0, 0], expected: [-3, 4, 0, 0] },
    { name: "false preserves unit vector", normalize: false, vector: [0, -1, 0, 0], expected: [0, -1, 0, 0] },
    { name: "false preserves near unit vector", normalize: false, vector: [1.0005, 0, 0, 0], expected: [1.0005, 0, 0, 0] },
    { name: "false accepts zero vector", normalize: false, vector: [0, 0, 0, 0], expected: [0, 0, 0, 0] },
  ];

  it.each(cases)("$name", async ({ normalize, vector, expected }) => {
    const original = [...vector];
    const test = setup(vector, normalize);
    Object.freeze(vector);
    Object.freeze(test.embeddings);
    await test.ingest();
    expect(test.textsSeen).toEqual([[request.text]]);
    expect(test.drafts).toHaveLength(1);
    expect(test.drafts[0].embedding).toEqual(expected);
    expect(test.drafts[0].embedding).not.toBe(vector);
    expect(test.embeddings).toEqual([original]);
  });

  it.each([undefined, true, false])("keeps the written vector independent after gateway mutation (normalize=%s)", async (normalize) => {
    const vector = [1, 0, 0, 0];
    const test = setup(vector, normalize);
    await test.ingest();
    expect(test.drafts).toHaveLength(1);
    expect(test.drafts[0].embedding).not.toBe(vector);
    vector[0] = 42;
    expect(test.drafts[0].embedding).toEqual([1, 0, 0, 0]);
  });

  it.each([
    { name: "wrong dimensions", vector: [1, 2, 3], message: /dimensions/ },
    { name: "NaN", vector: [1, NaN, 0, 0], message: /non-finite/ },
    { name: "infinity", vector: [1, Infinity, 0, 0], message: /non-finite/ },
  ])("rejects $name without normalization or writing", async ({ vector, message }) => {
    const test = setup(vector, false);
    Object.freeze(vector);
    Object.freeze(test.embeddings);
    await expect(test.ingest()).rejects.toThrow(message);
    expect(test.drafts).toEqual([]);
  });
});
