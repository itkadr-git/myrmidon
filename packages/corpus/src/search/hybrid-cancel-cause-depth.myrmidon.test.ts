import { describe, expect, it } from "vitest";

import { createPostgresSearchIndex, type SqlExecutor } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
const documentId = "cccccccc-0000-0000-0000-000000000003";
const embedding = Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);
const cancel = () => Object.assign(new Error("cancelled"), { code: "57014" });

function wrapped(depth: number): unknown {
  let error: unknown = cancel();
  for (let i = 0; i < depth; i += 1) error = { cause: error };
  return error;
}

function fixture(error: unknown) {
  const calls: string[] = [];
  let transactions = 0;
  const sql: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(text: string): Promise<Row[]> => {
      calls.push(text);
      if (/ts_rank/.test(text)) throw error;
      let rows: Record<string, unknown>[] = [];
      if (/pg_extension/.test(text)) rows = [{ extversion: "0.7.0" }];
      else if (/<=>/.test(text)) rows = [{ id: "chunk", company_id: companyId, document_id: documentId, chunk_index: 0, content: "vector hit", token_count: 2, metadata: {}, score: 0.9 }];
      else if (/select d\.id/.test(text)) rows = [{ id: documentId, dataset_id: datasetId, title: "Document", source_uri: null }];
      return rows as Row[];
    },
    withTransaction: async (run) => {
      transactions += 1;
      return run(sql);
    },
  };
  const events: unknown[] = [];
  const index = createPostgresSearchIndex({ sql, onFullTextTimeout: (event) => events.push(event) });
  return { index, calls, events, transactionCount: () => transactions };
}

async function search(error: unknown, withVector: boolean) {
  const f = fixture(error);
  const result = f.index.search({ companyId, datasetId, text: "supply agreement", ...(withVector ? { embedding } : {}) });
  return { ...f, result };
}

describe("full-text cancellation cause depth", () => {
  it.each([0, 1, 2, 3])("uses vector results for cancellation at depth %i", async (depth) => {
    const f = await search(wrapped(depth), true);
    const hits = await f.result;
    expect(hits.map((hit) => [hit.chunkId, hit.content, hit.fusion])).toEqual([
      ["chunk", "vector hit", { vectorRank: 1, fullTextRank: null }],
    ]);
    expect(f.events).toHaveLength(1);
    expect(f.calls.filter((call) => /ts_rank/.test(call))).toHaveLength(1);
    expect(f.calls.filter((call) => /<=>/.test(call))).toHaveLength(1);
    expect(f.calls.filter((call) => /select d\.id/.test(call))).toHaveLength(1);
    expect(f.transactionCount()).toBe(2);
  });

  it("propagates the same outer error when cancellation is at depth 4", async () => {
    const error = wrapped(4);
    const f = await search(error, true);
    await expect(f.result).rejects.toBe(error);
    expect(f.events).toHaveLength(0);
    expect(f.calls.filter((call) => /ts_rank/.test(call))).toHaveLength(1);
    expect(f.calls.filter((call) => /<=>/.test(call))).toHaveLength(1);
    expect(f.calls.filter((call) => /select d\.id/.test(call))).toHaveLength(0);
  });

  it("lets the first string code override a nested cancellation", async () => {
    const error = { code: "40P01", cause: cancel() };
    const f = await search(error, true);
    await expect(f.result).rejects.toBe(error);
    expect(f.events).toHaveLength(0);
    expect(f.calls.filter((call) => /ts_rank/.test(call))).toHaveLength(1);
  });

  it("skips a non-string code to find a nested cancellation", async () => {
    const f = await search({ code: 57014, cause: cancel() }, true);
    expect((await f.result).map((hit) => hit.chunkId)).toEqual(["chunk"]);
    expect(f.events).toHaveLength(1);
    expect(f.calls.filter((call) => /<=>/.test(call))).toHaveLength(1);
  });

  it("terminates and propagates a cyclic cause without a code", async () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    const f = await search(error, true);
    await expect(f.result).rejects.toBe(error);
    expect(f.events).toHaveLength(0);
    expect(f.calls.filter((call) => /ts_rank/.test(call))).toHaveLength(1);
  });

  it.each([
    ["cancellation", () => cancel()],
    ["wrapped cancellation", () => wrapped(3)],
    ["deadlock", () => ({ code: "40P01", cause: cancel() })],
    ["non-string code", () => ({ code: 57014, cause: cancel() })],
    ["depth 4", () => wrapped(4)],
    ["cycle", () => { const error: { cause?: unknown } = {}; error.cause = error; return error; }],
  ])("preserves %s identity without an embedding", async (_name, makeError) => {
    const error = makeError();
    const f = await search(error, false);
    await expect(f.result).rejects.toBe(error);
    expect(f.events).toHaveLength(0);
    expect(f.calls.filter((call) => /ts_rank/.test(call))).toHaveLength(1);
    expect(f.calls.filter((call) => /<=>/.test(call))).toHaveLength(0);
    expect(f.transactionCount()).toBe(1);
  });
});
