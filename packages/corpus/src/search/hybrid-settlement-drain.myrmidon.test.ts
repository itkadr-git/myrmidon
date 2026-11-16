import { describe, expect, it } from "vitest";
import { createPostgresSearchIndex, type SqlExecutor } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
const documentId = "cccccccc-0000-0000-0000-000000000003";
const row = { id: "a", company_id: companyId, document_id: documentId, chunk_index: 0, content: "chunk a", token_count: 12, metadata: {}, score: 0.9 };
const document = { id: documentId, dataset_id: datasetId, title: "Contract", source_uri: "file://contract.pdf" };
type Rows = Record<string, unknown>[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const legs = { vector: deferred<Rows>(), fullText: deferred<Rows>() };
  const started = { vector: deferred<void>(), fullText: deferred<void>() };
  const calls = { vector: 0, fullText: 0, hydration: 0, transactions: 0 };
  const sql: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(text: string): Promise<Row[]> => {
      if (/<=>/.test(text)) {
        calls.vector++;
        started.vector.resolve();
        return await legs.vector.promise as Row[];
      }
      if (/ts_rank/.test(text)) {
        calls.fullText++;
        started.fullText.resolve();
        return await legs.fullText.promise as Row[];
      }
      if (/select d\.id/.test(text)) {
        calls.hydration++;
        return [document] as unknown as Row[];
      }
      if (/pg_extension/.test(text)) return [{ extversion: "0.8.7" }] as unknown as Row[];
      if (/count\(\*\)::int as chunks/.test(text)) return [{ chunks: 50_000 }] as unknown as Row[];
      return [];
    },
    withTransaction: async (callback) => { calls.transactions++; return await callback(sql); },
  };
  const search = createPostgresSearchIndex({ sql }).search({
    companyId, datasetId, text: "supply agreement",
    embedding: Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0),
  });
  const outcome = search.then(value => ({ status: "fulfilled" as const, value }), error => ({ status: "rejected" as const, error }));
  return { legs, started, calls, outcome };
}

// Flush the promise queue without introducing a timing-dependent delay.
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

describe("hybrid search transaction settlement", () => {
  it.each(["vector", "fullText"] as const)("waits for the other ranking after %s rejects", async first => {
    const f = fixture();
    await Promise.all([f.started.vector.promise, f.started.fullText.promise]);
    let finished = false;
    void f.outcome.then(() => { finished = true; });
    const error = new Error(`${first} failed`);
    f.legs[first].reject(error);
    await nextTurn();
    expect(finished).toBe(false);
    expect(f.calls).toEqual({ vector: 1, fullText: 1, hydration: 0, transactions: 2 });
    f.legs[first === "vector" ? "fullText" : "vector"].resolve([row]);
    const result = await f.outcome;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.error).toBe(error);
    expect(f.calls.hydration).toBe(0);
  });

  it.each(["vector", "fullText"] as const)("keeps the vector error when %s rejects first and both fail", async first => {
    const f = fixture();
    await Promise.all([f.started.vector.promise, f.started.fullText.promise]);
    const errors = { vector: new Error("vector failed"), fullText: new Error("full text failed") };
    let finished = false;
    void f.outcome.then(() => { finished = true; });
    f.legs[first].reject(errors[first]);
    await nextTurn();
    expect(finished).toBe(false);
    const second = first === "vector" ? "fullText" : "vector";
    f.legs[second].reject(errors[second]);
    const result = await f.outcome;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.error).toBe(errors.vector);
    expect(f.calls).toEqual({ vector: 1, fullText: 1, hydration: 0, transactions: 2 });
  });

  it("returns the same hydrated result in either successful settlement order", async () => {
    const results = [];
    for (const first of ["vector", "fullText"] as const) {
      const f = fixture();
      await Promise.all([f.started.vector.promise, f.started.fullText.promise]);
      let finished = false;
      void f.outcome.then(() => { finished = true; });
      f.legs[first].resolve([row]);
      await nextTurn();
      expect(finished).toBe(false);
      expect(f.calls.hydration).toBe(0);
      f.legs[first === "vector" ? "fullText" : "vector"].resolve([row]);
      const result = await f.outcome;
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.error;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toMatchObject({ chunkId: "a", documentId, datasetId, content: "chunk a", fusion: { vectorRank: 1, fullTextRank: 1 } });
      expect(f.calls).toEqual({ vector: 1, fullText: 1, hydration: 1, transactions: 2 });
      results.push(result.value);
    }
    expect(results[0]).toEqual(results[1]);
  });
});
