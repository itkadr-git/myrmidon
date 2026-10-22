// myrmidon(CORPUS-2.0): ingestion pipeline — document text to embedded chunks.
//
// The pipeline is the seam between the corpus module and the company gateway: the chunker
// produces the windows, the embedder (a thin adapter over the gateway, injected here) turns a
// batch of windows into vectors, and the writer (the corpus store, injected here) upserts the
// rows into `corpus_chunks`. Embeddings are validated and L2-normalized before they are
// written, because the search compares them by cosine distance.
//
// Failures of the embedder are retried inside one batch and then rethrown: the caller is the
// module's work queue, which turns a retryable failure into a failed job with another attempt
// instead of losing the document.

import { chunkDocumentText } from "../chunking/chunker.js";
import type { ChunkingOptions } from "../chunking/types.js";
import {
  DEFAULT_RETRY_POLICY,
  defaultRetryContext,
  runWithRetries,
  type RetryContext,
  type RetryPolicy,
} from "../retry.js";
import type { Embedder, ReplaceCorpusChunksInput } from "../ports.js";
import {
  CORPUS_EMBEDDING_DIMENSIONS,
  assertEmbeddingVector,
  isL2Normalized,
  l2Normalize,
} from "../search/vector.js";

/** Batches of windows handed to the gateway; smaller batches keep a retry cheap. */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 16;

/** The chunks of one document, in the shape the CorpusStore writes them. */
export type CorpusChunkDraft = ReplaceCorpusChunksInput["chunks"][number];

export interface CorpusChunkWriter {
  /** Atomically replaces all chunks of one document (`CorpusStore.replaceDocumentChunks`). */
  replaceDocumentChunks(input: ReplaceCorpusChunksInput): Promise<unknown>;
}

export type EmbeddingBatchErrorCode = "count-mismatch";

export class EmbeddingBatchError extends Error {
  readonly code: EmbeddingBatchErrorCode;
  readonly retryable = false;

  constructor(code: EmbeddingBatchErrorCode, message: string) {
    super(message);
    this.name = "EmbeddingBatchError";
    this.code = code;
  }
}

export interface EmbeddingPipelineOptions {
  readonly batchSize?: number;
  readonly dimensions?: number;
  /** Normalize embeddings before writing; on by default. */
  readonly normalize?: boolean;
  readonly retry?: RetryPolicy;
  readonly retryContext?: Partial<RetryContext>;
  readonly chunking?: Partial<ChunkingOptions>;
}

export interface IngestDocumentRequest {
  readonly companyId: string;
  readonly datasetId: string;
  readonly documentId: string;
  readonly text: string;
}

export interface IngestionDependencies {
  /** The module's Embedder port (dashscope text-embedding-v4 through the company gateway). */
  readonly embedder: Embedder;
  readonly writer: CorpusChunkWriter;
}

export interface IngestionSummary {
  readonly documentId: string;
  readonly chunkCount: number;
  readonly batchCount: number;
  /** Number of calls actually made to the embedder, retries included. */
  readonly embeddingCalls: number;
}

export interface DocumentIngestionPipeline {
  ingest(request: IngestDocumentRequest, dependencies: IngestionDependencies): Promise<IngestionSummary>;
}

export function createDocumentIngestionPipeline(
  options: EmbeddingPipelineOptions = {},
): DocumentIngestionPipeline {
  const batchSize = options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("embedding batch size must be a positive integer");
  }
  const dimensions = options.dimensions ?? CORPUS_EMBEDDING_DIMENSIONS;
  const normalize = options.normalize ?? true;
  const retry = options.retry ?? DEFAULT_RETRY_POLICY;
  const retryContext: RetryContext = { ...defaultRetryContext(), ...options.retryContext };

  return {
    async ingest(request, dependencies): Promise<IngestionSummary> {
      const chunks = chunkDocumentText({
        documentId: request.documentId,
        text: request.text,
        chunking: options.chunking,
      });
      if (chunks.length === 0) {
        return { documentId: request.documentId, chunkCount: 0, batchCount: 0, embeddingCalls: 0 };
      }

      let embeddingCalls = 0;
      let batchCount = 0;
      const drafts: CorpusChunkDraft[] = [];
      for (let start = 0; start < chunks.length; start += batchSize) {
        const batch = chunks.slice(start, start + batchSize);
        const texts = batch.map((chunk) => chunk.content);
        const embeddings = await runWithRetries(
          retry,
          retryContext,
          async () => {
            embeddingCalls += 1;
            const embedded = await dependencies.embedder.embed({ texts: [...texts], dimensions });
            return embedded.embeddings;
          },
          isRetryableEmbeddingFailure,
        );
        if (embeddings.length !== texts.length) {
          throw new EmbeddingBatchError(
            "count-mismatch",
            `embedder returned ${embeddings.length} vectors for ${texts.length} texts`,
          );
        }
        drafts.push(
          ...batch.map((chunk, index) => ({
            chunkIndex: chunk.ordinal,
            content: chunk.content,
            embedding: [...prepareEmbedding(embeddings[index], dimensions, normalize)],
            tokenCount: null,
            metadata: { startOffset: chunk.startOffset, endOffset: chunk.endOffset },
          })),
        );
        batchCount += 1;
      }

      // One atomic replace at the end: `replaceDocumentChunks` swaps every chunk of the document in
      // a single call, so calling it per batch would wipe the batch before it. A failure while
      // embedding therefore leaves the chunks the document had.
      await dependencies.writer.replaceDocumentChunks({
        companyId: request.companyId,
        documentId: request.documentId,
        chunks: drafts,
      });

      return {
        documentId: request.documentId,
        chunkCount: chunks.length,
        batchCount,
        embeddingCalls,
      };
    },
  };
}

function prepareEmbedding(
  embedding: readonly number[],
  dimensions: number,
  normalize: boolean,
): readonly number[] {
  assertEmbeddingVector(embedding, dimensions);
  if (!normalize || isL2Normalized(embedding)) return embedding;
  return l2Normalize(embedding);
}

/** Gateway failures are retried unless the adapter explicitly marks them permanent. */
function isRetryableEmbeddingFailure(error: unknown): boolean {
  if (typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === false) {
    return false;
  }
  return true;
}