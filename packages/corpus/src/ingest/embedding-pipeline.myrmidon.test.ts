import { describe, expect, it } from "vitest";

import { chunkDocumentText } from "../chunking/chunker.js";
import {
  EmbeddingBatchError,
  createDocumentIngestionPipeline,
  type CorpusChunkRecord,
  type CorpusEmbedder,
} from "./embedding-pipeline.js";

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
const documentId = "cccccccc-0000-0000-0000-000000000003";

const fastRetry = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 };
const silentRetryContext = { sleep: async () => {}, random: () => 0 };

/** Five lines of 600 characters, which the window settings turn into five chunks. */
function documentText(): string {
  return Array.from({ length: 5 }, (_, index) => `${index}`.repeat(1) + "x".repeat(599)).join("\n");
}

function recordingWriter(): { writer: { upsertChunks(chunks: readonly CorpusChunkRecord[]): Promise<void> }; batches: CorpusChunkRecord[][] } {
  const batches: CorpusChunkRecord[][] = [];
  return {
    batches,
    writer: {
      async upsertChunks(chunks) {
        batches.push([...chunks]);
      },
    },
  };
}

function fakeEmbedder(dimensions = 4): { embedder: CorpusEmbedder; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    embedder: {
      async embedDocuments(texts) {
        calls.push([...texts]);
        return texts.map((text, index) =>
          Array.from({ length: dimensions }, (_, position) => (position === 0 ? text.length + index + 1 : 0)),
        );
      },
    },
  };
}

describe("document ingestion pipeline", () => {
  it("chunks, embeds in batches and writes normalized chunks to the store", async () => {
    const text = documentText();
    const { embedder, calls } = fakeEmbedder();
    const { writer, batches } = recordingWriter();
    const pipeline = createDocumentIngestionPipeline({
      batchSize: 2,
      dimensions: 4,
      retry: fastRetry,
      retryContext: silentRetryContext,
      chunking: { maxChars: 1_000, minChars: 300, overlapChars: 150 },
    });

    const summary = await pipeline.ingest({ companyId, datasetId, documentId, text }, { embedder, writer });

    expect(summary).toEqual({ documentId, chunkCount: 5, batchCount: 3, embeddingCalls: 3 });
    expect(calls.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);

    const expected = chunkDocumentText({ documentId, text, chunking: { maxChars: 1_000, minChars: 300, overlapChars: 150 } });
    const records = batches.flat();
    expect(records).toHaveLength(expected.length);
    records.forEach((record, index) => {
      expect(record.id).toBe(expected[index].id);
      expect(record.content).toBe(expected[index].content);
      expect(record.ordinal).toBe(expected[index].ordinal);
      expect(record.startOffset).toBe(expected[index].startOffset);
      expect(record.companyId).toBe(companyId);
      expect(record.datasetId).toBe(datasetId);
      expect(record.documentId).toBe(documentId);
      const norm = Math.sqrt(record.embedding.reduce((sum, value) => sum + value * value, 0));
      expect(norm).toBeCloseTo(1, 10);
    });
  });

  it("keeps the gateway embeddings when normalization is switched off", async () => {
    const { embedder } = fakeEmbedder();
    const { writer, batches } = recordingWriter();
    const pipeline = createDocumentIngestionPipeline({ batchSize: 10, dimensions: 4, normalize: false });

    await pipeline.ingest({ companyId, datasetId, documentId, text: documentText() }, { embedder, writer });

    const norm = Math.sqrt(batches[0][0].embedding.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeGreaterThan(1.5);
  });

  it("does nothing for a document without content", async () => {
    const { embedder, calls } = fakeEmbedder();
    const { writer, batches } = recordingWriter();
    const pipeline = createDocumentIngestionPipeline({ dimensions: 4 });

    const summary = await pipeline.ingest({ companyId, datasetId, documentId, text: " \n\n " }, { embedder, writer });

    expect(summary).toEqual({ documentId, chunkCount: 0, batchCount: 0, embeddingCalls: 0 });
    expect(calls).toEqual([]);
    expect(batches).toEqual([]);
  });

  it("retries a retryable gateway failure inside the batch", async () => {
    const { writer, batches } = recordingWriter();
    let attempts = 0;
    const embedder: CorpusEmbedder = {
      async embedDocuments(texts) {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("gateway 503"), { retryable: true });
        return texts.map(() => [1, 0, 0, 0]);
      },
    };
    const pipeline = createDocumentIngestionPipeline({
      batchSize: 10,
      dimensions: 4,
      retry: fastRetry,
      retryContext: silentRetryContext,
      chunking: { maxChars: 1_000, minChars: 300, overlapChars: 150 },
    });

    const summary = await pipeline.ingest({ companyId, datasetId, documentId, text: documentText() }, { embedder, writer });

    expect(summary.embeddingCalls).toBe(3);
    expect(summary.batchCount).toBe(1);
    expect(batches[0]).toHaveLength(5);
  });

  it("does not retry a failure the gateway adapter marked permanent", async () => {
    const { writer, batches } = recordingWriter();
    let attempts = 0;
    const embedder: CorpusEmbedder = {
      async embedDocuments() {
        attempts += 1;
        throw Object.assign(new Error("embedding model rejected the text"), { retryable: false });
      },
    };
    const pipeline = createDocumentIngestionPipeline({
      batchSize: 10,
      dimensions: 4,
      retry: fastRetry,
      retryContext: silentRetryContext,
      chunking: { maxChars: 1_000, minChars: 300, overlapChars: 150 },
    });

    await expect(
      pipeline.ingest({ companyId, datasetId, documentId, text: documentText() }, { embedder, writer }),
    ).rejects.toThrow("embedding model rejected the text");
    expect(attempts).toBe(1);
    expect(batches).toEqual([]);
  });

  it("fails the batch when the gateway returns a different number of vectors", async () => {
    const { writer } = recordingWriter();
    const embedder: CorpusEmbedder = {
      async embedDocuments() {
        return [[1, 0, 0, 0]];
      },
    };
    const pipeline = createDocumentIngestionPipeline({
      batchSize: 10,
      dimensions: 4,
      chunking: { maxChars: 1_000, minChars: 300, overlapChars: 150 },
    });

    const failure = await pipeline
      .ingest({ companyId, datasetId, documentId, text: documentText() }, { embedder, writer })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmbeddingBatchError);
    expect((failure as EmbeddingBatchError).retryable).toBe(false);
    expect((failure as EmbeddingBatchError).code).toBe("count-mismatch");
  });

  it("rejects an embedding with the wrong number of dimensions", async () => {
    const { writer } = recordingWriter();
    const embedder: CorpusEmbedder = {
      async embedDocuments(texts) {
        return texts.map(() => [1, 2, 3]);
      },
    };
    const pipeline = createDocumentIngestionPipeline({ dimensions: 1024, chunking: { maxChars: 100, minChars: 20, overlapChars: 10 } });

    await expect(
      pipeline.ingest({ companyId, datasetId, documentId, text: documentText() }, { embedder, writer }),
    ).rejects.toThrow(/1024/);
  });

  it("rejects a batch size outside the contract", () => {
    expect(() => createDocumentIngestionPipeline({ batchSize: 0 })).toThrow(RangeError);
  });
});