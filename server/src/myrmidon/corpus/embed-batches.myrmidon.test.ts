// server/src/myrmidon/corpus/embed-batches.myrmidon.test.ts
//
// myrmidon(1.6.6 CORPUS-2.0): the batching rules of the embedder, without a
// network. The HTTP part (key, headers, timeout, response checks) lives in
// `adapters.ts`; this file pins down only how a long list of texts is cut into
// requests.

import { describe, expect, it } from "vitest";
import { CORPUS_EMBED_BATCH_SIZE, embedInBatches } from "./embed-batches.js";

/** Texts "t0", "t1", ... so a vector can be traced back to its input. */
function texts(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t${i}`);
}

/** The vector of text "t<n>" is `[n]`. */
function vectorOf(text: string): number[] {
  return [Number(text.slice(1))];
}

describe("embedInBatches", () => {
  it("cuts 130 inputs into batches of 64, 64 and 2 and keeps the input order", async () => {
    const sizes: number[] = [];
    const vectors = await embedInBatches({
      input: texts(130),
      batchSize: 64,
      embedBatch: async (batch) => {
        sizes.push(batch.length);
        return batch.map(vectorOf);
      },
    });
    expect(sizes).toEqual([64, 64, 2]);
    expect(vectors).toHaveLength(130);
    expect(vectors).toEqual(Array.from({ length: 130 }, (_, i) => [i]));
  });

  it("sends the batches one after another, never in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await embedInBatches({
      input: texts(10),
      batchSize: 3,
      embedBatch: async (batch) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return batch.map(vectorOf);
      },
    });
    expect(maxInFlight).toBe(1);
  });

  it("uses the default batch size of 64 when none is given", async () => {
    expect(CORPUS_EMBED_BATCH_SIZE).toBe(64);
    const sizes: number[] = [];
    const vectors = await embedInBatches({
      input: texts(65),
      embedBatch: async (batch) => {
        sizes.push(batch.length);
        return batch.map(vectorOf);
      },
    });
    expect(sizes).toEqual([64, 1]);
    expect(vectors).toHaveLength(65);
  });

  it("returns an empty list without a call for an empty input", async () => {
    let calls = 0;
    const vectors = await embedInBatches({
      input: [],
      batchSize: 64,
      embedBatch: async (batch) => {
        calls += 1;
        return batch.map(vectorOf);
      },
    });
    expect(vectors).toEqual([]);
    expect(calls).toBe(0);
  });

  it("sends an input that fits in one batch as exactly one call", async () => {
    const sizes: number[] = [];
    const vectors = await embedInBatches({
      input: texts(1),
      embedBatch: async (batch) => {
        sizes.push(batch.length);
        return batch.map(vectorOf);
      },
    });
    expect(sizes).toEqual([1]);
    expect(vectors).toEqual([[0]]);
  });

  it("passes the error of the second batch on and does not send the third", async () => {
    const sizes: number[] = [];
    await expect(
      embedInBatches({
        input: texts(130),
        batchSize: 64,
        embedBatch: async (batch) => {
          sizes.push(batch.length);
          if (sizes.length === 2) throw new Error("embedding endpoint failed");
          return batch.map(vectorOf);
        },
      }),
    ).rejects.toThrow("embedding endpoint failed");
    expect(sizes).toEqual([64, 64]);
  });

  it("rejects a batch that returns a different number of vectors than inputs", async () => {
    await expect(
      embedInBatches({
        input: texts(5),
        batchSize: 2,
        embedBatch: async (batch) => batch.slice(1).map(vectorOf),
      }),
    ).rejects.toThrow("embedding batch returned 1 vectors for 2 inputs");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects the batch size %s with a RangeError and sends nothing", async (batchSize) => {
    let calls = 0;
    await expect(
      embedInBatches({
        input: texts(3),
        batchSize,
        embedBatch: async (batch) => {
          calls += 1;
          return batch.map(vectorOf);
        },
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  });
});
