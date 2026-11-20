import { describe, expect, it } from "vitest";
import type { Embedder, ReplaceCorpusChunksInput } from "../ports.js";
import { createDocumentIngestionPipeline } from "./embedding-pipeline.js";

const companyId = "company";
const datasetId = "dataset";
const documentId = "document";
const lines = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"];
const options = {
  dimensions: 4,
  chunking: { maxChars: 8, minChars: 1, overlapChars: 0 },
  retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
  retryContext: { sleep: async () => {}, random: () => 0 },
};

function ports(failCall?: number) {
  const calls: { texts: string[]; dimensions: number | undefined }[] = [];
  const writes: ReplaceCorpusChunksInput[] = [];
  const embedder: Embedder = {
    async embed({ texts, dimensions }) {
      calls.push({ texts: [...texts], dimensions });
      if (calls.length === failCall) throw new Error("transient");
      return { model: "test", dimensions: 4, embeddings: texts.map(() => [1, 0, 0, 0]) };
    },
  };
  return { calls, writes, embedder, writer: { async replaceDocumentChunks(input: ReplaceCorpusChunksInput) { writes.push(input); } } };
}

function expectedWrite(count: number): ReplaceCorpusChunksInput {
  return {
    companyId,
    documentId,
    chunks: lines.slice(0, count).map((content, chunkIndex) => ({
      chunkIndex,
      content,
      embedding: [1, 0, 0, 0],
      tokenCount: null,
      metadata: { startOffset: chunkIndex * 9, endOffset: chunkIndex * 9 + 8 },
    })),
  };
}

describe("embedding batch accounting", () => {
  const cases = [1, 2, 3, 5].flatMap((count) => [1, 2, count + 1].map((batchSize) => ({ count, batchSize })));
  it.each(cases)("accounts for $count chunks with batch size $batchSize", async ({ count, batchSize }) => {
    const p = ports();
    const summary = await createDocumentIngestionPipeline({ ...options, batchSize }).ingest(
      { companyId, datasetId, documentId, text: lines.slice(0, count).join("\n") }, p,
    );
    const batches = Array.from({ length: Math.ceil(count / batchSize) }, (_, index) => ({
      texts: lines.slice(index * batchSize, Math.min((index + 1) * batchSize, count)), dimensions: 4,
    }));
    expect(p.calls).toEqual(batches);
    expect(p.writes).toEqual([expectedWrite(count)]);
    expect(summary).toEqual({ documentId, chunkCount: count, batchCount: batches.length, embeddingCalls: batches.length });
  });

  it("counts a retry as a call, not a successful batch", async () => {
    const p = ports(2);
    const summary = await createDocumentIngestionPipeline({ ...options, batchSize: 2 }).ingest(
      { companyId, datasetId, documentId, text: lines.join("\n") }, p,
    );
    expect(p.calls).toEqual([
      { texts: ["aaaaaaaa", "bbbbbbbb"], dimensions: 4 },
      { texts: ["cccccccc", "dddddddd"], dimensions: 4 },
      { texts: ["cccccccc", "dddddddd"], dimensions: 4 },
      { texts: ["eeeeeeee"], dimensions: 4 },
    ]);
    expect(p.writes).toEqual([expectedWrite(5)]);
    expect(summary).toEqual({ documentId, chunkCount: 5, batchCount: 3, embeddingCalls: 4 });
  });

  it.each(["", " \t\n\r\f\v "])("does not call ports for empty or ASCII whitespace input %j", async (text) => {
    const p = ports();
    const summary = await createDocumentIngestionPipeline(options).ingest({ companyId, datasetId, documentId, text }, p);
    expect(summary).toEqual({ documentId, chunkCount: 0, batchCount: 0, embeddingCalls: 0 });
    expect(p.calls).toEqual([]);
    expect(p.writes).toEqual([]);
  });
});
