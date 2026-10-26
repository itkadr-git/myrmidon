import { describe, expect, it, vi } from "vitest";
import {
  createRagflowSource,
  importRagflowCorpus,
  type CorpusImportChunk,
  type CorpusImportDataset,
  type CorpusImportDocument,
  type CorpusImportTarget,
  type RagflowChunk,
  type RagflowDataset,
  type RagflowDocument,
  type RagflowSource,
} from "./ragflow.js";

async function* iterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function fixtureSource(): RagflowSource {
  const dataset: RagflowDataset = { id: "kb-01", name: "Support KB", description: "fixture", embedding_model: "old-model" };
  const documents: RagflowDocument[] = [{ id: "doc-01", name: "guide.pdf", size: 987, type: "pdf", run: "DONE", chunk_count: 5 }];
  const chunks: RagflowChunk[] = [
    { id: "chunk-a", content: "first ready chunk", positions: [[0, 17]], important_keywords: ["first"] },
    { id: "chunk-b", content: "second ready chunk", positions: [[18, 37]], important_keywords: ["second"] },
    { id: "chunk-c", content: "third ready chunk", positions: [[38, 56]], important_keywords: [] },
    { id: "chunk-d", content: "fourth ready chunk", positions: [[57, 75]], important_keywords: [] },
    { id: "chunk-e", content: "fifth ready chunk", positions: [[76, 93]], important_keywords: [] },
  ];
  return {
    baseUrl: "https://ragflow.example",
    async listDatasets() { return [dataset]; },
    async countDatasets() { return 1; },
    listDocuments: async function* (datasetId) {
      expect(datasetId).toBe(dataset.id);
      yield* documents;
    },
    listChunks: async function* (datasetId, documentId) {
      expect(datasetId).toBe(dataset.id);
      expect(documentId).toBe(documents[0]!.id);
      yield* chunks;
    },
    async countChunks(datasetId, documentId) {
      expect(datasetId).toBe(dataset.id);
      expect(documentId).toBe(documents[0]!.id);
      return chunks.length;
    },
  };
}

function memoryTarget() {
  const datasets = new Map<string, CorpusImportDataset>();
  const documents = new Map<string, CorpusImportDocument>();
  const chunks = new Map<string, CorpusImportChunk>();
  const ready: string[] = [];
  const target: CorpusImportTarget = {
    async upsertDataset(value) { datasets.set(value.id, value); },
    async upsertDocument(value) { documents.set(value.id, value); },
    async getChunkStates(companyId, ids) {
      return new Map(ids.flatMap((id) => {
        const chunk = chunks.get(id);
        return chunk ? [[id, {
          content: chunk.content,
          embedding: chunk.embedding,
          embeddingModel: typeof chunk.metadata.embeddingModel === "string" ? chunk.metadata.embeddingModel : null,
          embeddingDimensions: typeof chunk.metadata.embeddingDimensions === "number" ? chunk.metadata.embeddingDimensions : null,
          embeddingContentHash: typeof chunk.metadata.embeddingContentHash === "string" ? chunk.metadata.embeddingContentHash : null,
        }]] : [];
      }));
    },
    async upsertChunks(values) {
      for (const value of values) {
        const old = chunks.get(value.id);
        chunks.set(value.id, { ...value, embedding: value.embedding ?? old?.embedding ?? null });
      }
    },
    async markDocumentReady(_companyId, documentId) { ready.push(documentId); },
  };
  return { target, datasets, documents, chunks, ready };
}

const embedFixture = async (texts: string[]) => texts.map((text) => [text.length, 1, 2, 3]);

describe("RAGFlow corpus import", () => {
  it("imports ready chunks, positions and metadata then resumes without re-embedding", async () => {
    const memory = memoryTarget();
    const calls: string[][] = [];
    let activeEmbeddings = 0;
    let maxActiveEmbeddings = 0;
    const options = {
      source: fixtureSource(),
      target: memory.target,
      companyId: "aaaaaaaa-0000-0000-0000-000000000001",
      embeddingModel: "pilot-model",
      embeddingDimensions: 4,
      embeddingBatchSize: 2,
      embeddingConcurrency: 2,
      embed: async (texts: string[]) => {
        calls.push([...texts]);
        activeEmbeddings += 1;
        maxActiveEmbeddings = Math.max(maxActiveEmbeddings, activeEmbeddings);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeEmbeddings -= 1;
        return embedFixture(texts);
      },
    };

    const first = await importRagflowCorpus(options);
    expect(first).toMatchObject({ datasets: 1, documents: 1, chunks: 5, embedded: 5, reused: 0 });
    expect(calls.map((call) => call.length).sort()).toEqual([1, 2, 2]);
    expect(maxActiveEmbeddings).toBeGreaterThan(1);
    expect(memory.datasets.size).toBe(1);
    expect(memory.documents.size).toBe(1);
    expect(memory.chunks.size).toBe(5);
    for (const chunk of memory.chunks.values()) {
      expect(chunk.embedding).toHaveLength(4);
      expect(Math.hypot(...chunk.embedding!)).toBeCloseTo(1, 3);
    }
    expect([...memory.chunks.values()][0]?.metadata).toMatchObject({
      ragflowDatasetId: "kb-01",
      ragflowDocumentId: "doc-01",
      ragflowChunkId: "chunk-a",
      positions: [[0, 17]],
    });
    expect([...memory.documents.values()][0]).toMatchObject({
      title: "guide.pdf",
      sourceUri: "https://ragflow.example/api/v1/datasets/kb-01/documents/doc-01",
      contentType: "application/pdf",
      byteSize: 987,
    });
    expect(memory.ready).toHaveLength(1);

    const second = await importRagflowCorpus(options);
    expect(second).toMatchObject({ datasets: 1, documents: 1, chunks: 5, embedded: 0, reused: 5 });
    expect(calls).toHaveLength(3);
    expect(memory.datasets.size).toBe(1);
    expect(memory.documents.size).toBe(1);
    expect(memory.chunks.size).toBe(5);

    const originalSource = fixtureSource();
    const modifiedChunks: RagflowChunk[] = [];
    for await (const chunk of originalSource.listChunks("kb-01", "doc-01")) modifiedChunks.push(chunk);
    modifiedChunks[0] = { ...modifiedChunks[0]!, content: "corrected source content" };
    const changedSource: RagflowSource = {
      ...originalSource,
      listChunks: async function* () { yield* modifiedChunks; },
    };
    const changedContent = await importRagflowCorpus({ ...options, source: changedSource });
    expect(changedContent).toMatchObject({ datasets: 1, documents: 1, chunks: 5, embedded: 1, reused: 4 });
    expect(calls).toHaveLength(4);
    expect(memory.chunks.size).toBe(5);

    const changedModel = await importRagflowCorpus({ ...options, embeddingModel: "replacement-model" });
    expect(changedModel).toMatchObject({ datasets: 1, documents: 1, chunks: 5, embedded: 5, reused: 0 });
    expect(calls).toHaveLength(7);
    expect(memory.datasets.values().next().value?.embeddingModel).toBe("replacement-model");
    expect(memory.chunks.size).toBe(5);
  });

  it("resumes after a partial concurrent embedding failure without dropping stored vectors", async () => {
    const memory = memoryTarget();
    let failFirstBatch = true;
    const calls: string[][] = [];
    const options = {
      source: fixtureSource(),
      target: memory.target,
      companyId: "aaaaaaaa-0000-0000-0000-000000000001",
      embeddingModel: "pilot-model",
      embeddingDimensions: 4,
      embeddingBatchSize: 2,
      embeddingConcurrency: 2,
      embed: async (texts: string[]) => {
        calls.push([...texts]);
        if (texts.includes("first ready chunk") && failFirstBatch) {
          failFirstBatch = false;
          throw new Error("transient embedding failure");
        }
        return embedFixture(texts);
      },
    };

    await expect(importRagflowCorpus(options)).rejects.toThrow("transient embedding failure");
    expect(memory.ready).toHaveLength(0);
    const persistedVectors = [...memory.chunks.values()].filter((chunk) => chunk.embedding !== null);
    expect(persistedVectors.length).toBeGreaterThan(0);
    expect(persistedVectors.length).toBeLessThan(5);

    const resumed = await importRagflowCorpus(options);
    expect(resumed).toMatchObject({ datasets: 1, documents: 1, chunks: 5, embedded: 3, reused: 2 });
    expect(resumed.embedded + resumed.reused).toBe(5);
    expect(memory.chunks.size).toBe(5);
    expect([...memory.chunks.values()].every((chunk) => chunk.embedding?.length === 4)).toBe(true);
    expect(memory.ready).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it("fetches paginated dataset, document and chunk lists using the read-only API", async () => {
    const calls: string[] = [];
    const pages: Record<string, unknown> = {
      "/api/v1/datasets?page=1&page_size=1": { code: 0, data: { datasets: [{ id: "d1", name: "one" }], total_datasets: 1 } },
      "/api/v1/datasets/d1/documents?page=1&page_size=1": { code: 0, data: { docs: [{ id: "f1", name: "f.txt" }], total: 2 } },
      "/api/v1/datasets/d1/documents?page=2&page_size=1": { code: 0, data: { docs: [{ id: "f2", name: "g.txt" }], total: 2 } },
      "/api/v1/datasets/d1/documents/f1/chunks?page=1&page_size=1": { code: 0, data: { chunks: [{ id: "c1", content: "one" }], total: 2 } },
      "/api/v1/datasets/d1/documents/f1/chunks?page=2&page_size=1": { code: 0, data: { chunks: [{ id: "c2", content: "two" }], total: 2 } },
    };
    const source = createRagflowSource({
      baseUrl: "https://ragflow.example/",
      apiKey: "test-key",
      pageSize: 1,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        calls.push(url.pathname + url.search);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        const body = pages[url.pathname + url.search];
        if (body === undefined) throw new Error(`Unexpected URL ${url.pathname + url.search}`);
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect((await source.listDatasets()).map((dataset) => dataset.id)).toEqual(["d1"]);
    const docs: RagflowDocument[] = [];
    for await (const document of source.listDocuments("d1")) docs.push(document);
    const chunks: RagflowChunk[] = [];
    for await (const chunk of source.listChunks("d1", "f1")) chunks.push(chunk);
    expect(docs.map((document) => document.id)).toEqual(["f1", "f2"]);
    expect(chunks.map((chunk) => chunk.id)).toEqual(["c1", "c2"]);
    expect(await source.countChunks?.("d1", "f1")).toBe(2);
    expect(calls).toHaveLength(6);
  });

  it("uses the pilot embedding model as its default", async () => {
    const memory = memoryTarget();
    const result = await importRagflowCorpus({
      source: fixtureSource(),
      target: memory.target,
      companyId: "aaaaaaaa-0000-0000-0000-000000000001",
      embeddingDimensions: 4,
      embed: embedFixture,
    });
    expect(result.embedded).toBe(5);
    expect(memory.datasets.values().next().value?.embeddingModel).toBe("hindsight-embed-bge-m3");
  });

  it("refuses source document and chunk count mismatches before embeddings or writes", async () => {
    const base = fixtureSource();
    const sourceDocumentMismatch: RagflowSource = {
      ...base,
      async listDatasets() { return [{ id: "kb-01", name: "Support KB", document_count: 2 }]; },
    };
    const docTarget = memoryTarget();
    const docEmbed = vi.fn(embedFixture);
    await expect(importRagflowCorpus({ source: sourceDocumentMismatch, target: docTarget.target, companyId: "aaaaaaaa-0000-0000-0000-000000000001", embeddingDimensions: 4, embed: docEmbed })).rejects.toThrow("document count mismatch");
    expect(docEmbed).not.toHaveBeenCalled();
    expect(docTarget.datasets.size).toBe(0);

    const sourceChunkMismatch: RagflowSource = {
      ...base,
      async countChunks() { return 4; },
    };
    const chunkTarget = memoryTarget();
    const chunkEmbed = vi.fn(embedFixture);
    await expect(importRagflowCorpus({ source: sourceChunkMismatch, target: chunkTarget.target, companyId: "aaaaaaaa-0000-0000-0000-000000000001", embeddingDimensions: 4, embed: chunkEmbed })).rejects.toThrow("chunk count mismatch");
    expect(chunkEmbed).not.toHaveBeenCalled();
    expect(chunkTarget.datasets.size).toBe(0);
    expect(chunkTarget.documents.size).toBe(0);
    expect(chunkTarget.chunks.size).toBe(0);
  });

  it("refuses incomplete chunk streams and invalid embedding vectors", async () => {
    const source = fixtureSource();
    const incompleteSource: RagflowSource = {
      ...source,
      async *listChunks() {
        yield { id: "chunk-a", content: "first ready chunk", positions: [[0, 17]] };
      },
      async countChunks() { return 5; },
    };
    await expect(importRagflowCorpus({
      source: incompleteSource,
      target: memoryTarget().target,
      companyId: "aaaaaaaa-0000-0000-0000-000000000001",
      embeddingDimensions: 4,
      embed: embedFixture,
    })).rejects.toThrow("chunk count mismatch");

    const invalidVectorSource: RagflowSource = {
      ...source,
      async *listDocuments() { yield { id: "doc-01", name: "guide.pdf", run: "DONE", chunk_count: 1 }; },
      async countChunks() { return 1; },
      listChunks: () => iterable([{ id: "only-one", content: "one", total_chunks: 1 }]),
    };
    await expect(importRagflowCorpus({
      source: invalidVectorSource,
      target: memoryTarget().target,
      companyId: "aaaaaaaa-0000-0000-0000-000000000001",
      embeddingDimensions: 4,
      embed: async () => [[Number.NaN, 0, 0, 0]],
    })).rejects.toThrow("non-finite number");
  });
});
