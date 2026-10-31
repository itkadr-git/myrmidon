// server/src/myrmidon/corpus/embed-batches.ts
//
// myrmidon(1.6.6 CORPUS-2.0): embeds a long list of texts as a series of
// bounded requests instead of one request with every text in it.
//
// Why: a document can yield thousands of chunks. Cloud embedding endpoints cap the
// number of inputs per request (some answer 400 above a few hundred), and one huge
// request can run longer than any sensible network timeout. A series of small
// requests stays under both limits.
//
// This file is pure: it knows nothing about HTTP, keys or models. The caller gives
// it the function that embeds ONE batch, so the splitting rules are testable
// without a network.

/** How many texts go into one embedding request. */
export const CORPUS_EMBED_BATCH_SIZE = 64;

export interface EmbedInBatchesOptions {
  /** Every text to embed, in the order the vectors must come back. */
  input: readonly string[];
  /** Texts per request. A positive integer; defaults to `CORPUS_EMBED_BATCH_SIZE`. */
  batchSize?: number;
  /** Embeds one batch and returns exactly one vector per text, in the same order. */
  embedBatch: (batch: readonly string[]) => Promise<number[][]>;
}

/**
 * Splits `input` into batches of at most `batchSize` texts and embeds them one
 * after another (never in parallel, so one document cannot flood the endpoint).
 * Returns one flat list of vectors in input order; its length equals the number of
 * texts. An empty input returns an empty list without a call.
 *
 * A failing batch rejects the whole call and no later batch is sent: a document is
 * indexed all or nothing, and the parse worker retries it from the start.
 */
export async function embedInBatches({
  input,
  batchSize = CORPUS_EMBED_BATCH_SIZE,
  embedBatch,
}: EmbedInBatchesOptions): Promise<number[][]> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`embedding batch size must be a positive integer (got ${batchSize})`);
  }
  const vectors: number[][] = [];
  for (let start = 0; start < input.length; start += batchSize) {
    const batch = input.slice(start, start + batchSize);
    const batchVectors = await embedBatch(batch);
    if (batchVectors.length !== batch.length) {
      throw new Error(`embedding batch returned ${batchVectors.length} vectors for ${batch.length} inputs`);
    }
    vectors.push(...batchVectors);
  }
  return vectors;
}
