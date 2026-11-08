// myrmidon(1.6.7 OPE-12272): a search may be given the embedding as a promise. The full-text ranking
// does not need the vector, so it starts at once; the vector ranking starts when the embedding is ready.

import { describe, expect, it } from "vitest";

import { createPostgresSearchIndex, type FullTextTimeoutEvent, type SqlExecutor } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
// One document per chunk, because a search keeps only the best chunk of each document.
const documentIds: Record<string, string> = {
  a: "cccccccc-0000-0000-0000-00000000000a",
  b: "cccccccc-0000-0000-0000-00000000000b",
  c: "cccccccc-0000-0000-0000-00000000000c",
};
const question = "how do I light the charcoal in the grill";

function chunkRow(id: string, chunkIndex: number, score: number) {
  return {
    id,
    company_id: companyId,
    document_id: documentIds[id]!,
    chunk_index: chunkIndex,
    content: `chunk ${id}`,
    token_count: 12,
    metadata: {},
    score,
  };
}

const documents = Object.entries(documentIds).map(([name, id]) => ({
  id,
  dataset_id: datasetId,
  title: `Grill ${name}`,
  source_uri: `file://grill-${name}.pdf`,
}));

function embedding(): number[] {
  return Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, index) => (index === 0 ? 1 : 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-scheduled microtask and timer callback run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A fake executor that logs the order of the interesting statements in `events`. */
function createSql(
  events: string[],
  rows: { vector: ReturnType<typeof chunkRow>[]; fullText: ReturnType<typeof chunkRow>[] },
  options: { fullTextError?: Error } = {},
): SqlExecutor {
  const executor: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(text: string): Promise<Row[]> => {
      if (/set local statement_timeout/i.test(text)) {
        events.push("full-text timeout set");
        return [];
      }
      if (/ts_rank/.test(text)) {
        events.push("full-text ranking");
        if (options.fullTextError) throw options.fullTextError;
        return rows.fullText as unknown as Row[];
      }
      if (/pg_extension/.test(text)) return [{ extversion: "0.8.7" }] as unknown as Row[];
      if (/<=>/.test(text)) {
        events.push("vector ranking");
        return rows.vector as unknown as Row[];
      }
      if (/select d\.id/.test(text)) return documents as unknown as Row[];
      return [];
    },
    withTransaction: (callback) => callback(executor),
  };
  return executor;
}

const rows = {
  vector: [chunkRow("a", 0, 0.9), chunkRow("b", 1, 0.8)],
  fullText: [chunkRow("b", 1, 0.4), chunkRow("c", 2, 0.3)],
};

describe("search with a late embedding (OPE-12272)", () => {
  it("starts the full-text ranking before the embedding is ready, and the vector ranking after it", async () => {
    const events: string[] = [];
    const index = createPostgresSearchIndex({ sql: createSql(events, rows) });
    const embedder = deferred<number[]>(); // a fake embedder that is slow

    const searching = index.search({ companyId, datasetId, text: question, embedding: embedder.promise });
    await settle();
    // The embedding is still pending: the full-text ranking has run, with its time bound set first,
    // and the vector ranking has not started.
    expect(events).toEqual(["full-text timeout set", "full-text ranking"]);

    events.push("embedding ready");
    embedder.resolve(embedding());
    await searching;
    expect(events).toEqual(["full-text timeout set", "full-text ranking", "embedding ready", "vector ranking"]);
  });

  it("returns the same hits as a search that was given the ready vector", async () => {
    const ready = await createPostgresSearchIndex({ sql: createSql([], rows) }).search({
      companyId,
      datasetId,
      text: question,
      embedding: embedding(),
    });
    const late = deferred<number[]>();
    const searching = createPostgresSearchIndex({ sql: createSql([], rows) }).search({
      companyId,
      datasetId,
      text: question,
      embedding: late.promise,
    });
    await settle();
    late.resolve(embedding());

    expect(await searching).toEqual(ready);
    expect(ready.map((hit) => hit.chunkId)).toEqual(["b", "a", "c"]);
  });

  it("takes an embedding that is already resolved like a ready one", async () => {
    const hits = await createPostgresSearchIndex({ sql: createSql([], rows) }).search({
      companyId,
      datasetId,
      text: question,
      embedding: Promise.resolve(embedding()),
    });
    expect(hits.map((hit) => hit.chunkId)).toEqual(["b", "a", "c"]);
  });

  it("answers from the vector ranking when the cancelled full-text ranking ran while the embedding was pending", async () => {
    const events: string[] = [];
    const cancel = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const timeouts: FullTextTimeoutEvent[] = [];
    const index = createPostgresSearchIndex({
      sql: createSql(events, rows, { fullTextError: cancel }),
      onFullTextTimeout: (event) => timeouts.push(event),
    });
    const embedder = deferred<number[]>();

    const searching = index.search({ companyId, datasetId, text: question, embedding: embedder.promise });
    await settle();
    expect(timeouts).toHaveLength(1);
    embedder.resolve(embedding());

    expect((await searching).map((hit) => hit.chunkId)).toEqual(["a", "b"]);
  });

  it("fails the search when the embedding fails, and does not start the vector ranking", async () => {
    const events: string[] = [];
    const index = createPostgresSearchIndex({ sql: createSql(events, rows) });
    const embedder = deferred<number[]>();

    const searching = index.search({ companyId, datasetId, text: question, embedding: embedder.promise });
    const outcome = searching.then(() => null, (error: unknown) => error);
    await settle();
    embedder.reject(new Error("embedder unavailable"));

    expect(((await outcome) as Error).message).toBe("embedder unavailable");
    expect(events).not.toContain("vector ranking");
  });

  it("checks the shape of a late vector when it arrives", async () => {
    const index = createPostgresSearchIndex({ sql: createSql([], rows) });
    await expect(
      index.search({ companyId, datasetId, text: question, embedding: Promise.resolve([1, 2, 3]) }),
    ).rejects.toThrow(/1024/);
  });

  it("starts nothing for a search with neither text nor embedding", async () => {
    const events: string[] = [];
    const index = createPostgresSearchIndex({ sql: createSql(events, rows) });
    expect(await index.search({ companyId, datasetId, text: "  " })).toEqual([]);
    expect(events).toEqual([]);
  });

  it("waits for a late vector in a search that has no text, and runs only the vector ranking", async () => {
    const events: string[] = [];
    const index = createPostgresSearchIndex({ sql: createSql(events, rows) });
    const hits = await index.search({ companyId, datasetId, text: "", embedding: Promise.resolve(embedding()) });
    expect(events).toEqual(["vector ranking"]);
    expect(hits.map((hit) => hit.chunkId)).toEqual(["a", "b"]);
  });
});
