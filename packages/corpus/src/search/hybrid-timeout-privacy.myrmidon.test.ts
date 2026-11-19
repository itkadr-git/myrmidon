import { afterEach, describe, expect, it, vi } from "vitest";
import { createPostgresSearchIndex, type FullTextTimeoutEvent, type SqlExecutor } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
const documentId = "cccccccc-0000-0000-0000-000000000003";
const sentinel = "unique-secret-privacy-14372";
const embedding = Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);
const cancel = () => Object.assign(new Error(`SQL secret ${sentinel}`), { code: "57014" });

function fixture(result: "cancel" | "success" | "error" | "vector-cancel", failure: unknown = cancel()) {
  const calls: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sql: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(text: string): Promise<Row[]> => {
      calls.push(text);
      if (/ts_rank/.test(text)) {
        entered();
        await gate;
        if (result === "cancel" || result === "error") throw failure;
        return [];
      }
      if (/<=>/.test(text)) {
        if (result === "vector-cancel") throw failure;
        return [{ id: "chunk", company_id: companyId, document_id: documentId, chunk_index: 0, content: "safe", token_count: 1, metadata: {}, score: 0.9 }] as unknown as Row[];
      }
      if (/select d\.id/.test(text)) return [{ id: documentId, dataset_id: datasetId, title: "Doc", source_uri: null }] as unknown as Row[];
      return [];
    },
    withTransaction: (run) => run(sql),
  };
  return { sql, calls, ready, release };
}

afterEach(() => vi.useRealTimers());

describe("full-text timeout diagnostic privacy", () => {
  it.each([
    { timeout: 0, text: `  ${sentinel}  `, substring: true, datasets: [datasetId] },
    { timeout: 237, text: `  query ${sentinel} with spaces  `, substring: false, datasets: null },
  ])("emits exactly the allowed fields with trimmed length and exact elapsed time: $timeout", async ({ timeout, text, substring, datasets }) => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const db = fixture("cancel");
    const events: FullTextTimeoutEvent[] = [];
    const search = createPostgresSearchIndex({ sql: db.sql, fullTextTimeoutMs: timeout, onFullTextTimeout: (event) => events.push(event) })
      .search({ companyId, ...(datasets ? { datasetIds: datasets } : {}), text, embedding });
    await db.ready;
    vi.setSystemTime(10137);
    db.release();
    const hits = await search;
    expect(hits.map((hit) => hit.chunkId)).toEqual(["chunk"]);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]).sort()).toEqual(["companyId", "datasetIds", "elapsedMs", "substringMatch", "textLength", "timeoutMs"]);
    expect(events[0]).toEqual({ companyId, datasetIds: datasets, elapsedMs: 137, substringMatch: substring, textLength: text.trim().length, timeoutMs: timeout });
    if (datasets) expect(events[0].datasetIds).toBe(datasets);
    expect(JSON.stringify(events[0])).not.toContain(sentinel);
    expect(db.calls.filter((sql) => /statement_timeout/.test(sql))).toEqual(timeout ? [`set local statement_timeout = ${timeout}`] : []);
  });

  it("does not notify for success, non-cancel errors, text-only cancel, or vector cancel", async () => {
    const other = Object.assign(new Error("deadlock"), { code: "40P01" });
    for (const scenario of ["success", "error", "text-only", "vector-cancel"] as const) {
      const failure = scenario === "error" ? other : cancel();
      const db = fixture(scenario === "text-only" ? "cancel" : scenario, failure);
      const callback = vi.fn();
      const pending = createPostgresSearchIndex({ sql: db.sql, onFullTextTimeout: callback }).search({ companyId, datasetId, text: sentinel, ...(scenario === "text-only" ? {} : { embedding }) });
      await db.ready;
      db.release();
      if (scenario === "success") await pending;
      else await expect(pending).rejects.toBe(failure);
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it("preserves all hits when the callback throws", async () => {
    const run = async (throws: boolean) => {
      const db = fixture("cancel");
      const callback = vi.fn(() => { if (throws) throw new Error("diagnostic failure"); });
      const pending = createPostgresSearchIndex({ sql: db.sql, onFullTextTimeout: callback }).search({ companyId, datasetId, text: sentinel, embedding });
      await db.ready;
      db.release();
      const hits = await pending;
      expect(callback).toHaveBeenCalledTimes(1);
      return hits;
    };
    const normal = await run(false);
    expect(normal.map((hit) => hit.chunkId)).toEqual(["chunk"]);
    expect(await run(true)).toEqual(normal);
  });
});
