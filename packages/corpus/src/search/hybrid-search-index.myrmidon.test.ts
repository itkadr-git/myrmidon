import { describe, expect, it } from "vitest";

import { createPostgresSearchIndex, escapeLikePattern, type SqlExecutor } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
const documentId = "cccccccc-0000-0000-0000-000000000003";

interface RecordedCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface ChunkRow {
  id: string;
  company_id: string;
  dataset_id: string;
  document_id: string;
  ordinal: number;
  content: string;
  score: number;
}

function chunkRow(id: string, ordinal: number, score: number): ChunkRow {
  return {
    id,
    company_id: companyId,
    dataset_id: datasetId,
    document_id: documentId,
    ordinal,
    content: `chunk ${id}`,
    score,
  };
}

function createRecordingSql(rows: { vector: ChunkRow[]; fullText: ChunkRow[]; documents?: unknown[] }): {
  sql: SqlExecutor;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const handle = async (text: string, values: readonly unknown[] = []): Promise<unknown[]> => {
    calls.push({ text, values });
    if (/set local hnsw\.ef_search/i.test(text)) return [];
    if (/ts_rank/.test(text)) return rows.fullText;
    if (/<=>/.test(text)) return rows.vector;
    if (/select d\.id/.test(text)) return rows.documents ?? [];
    return [];
  };
  const executor: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      (await handle(text, values)) as Row[],
    withTransaction: (callback) => callback(executor),
  };
  return { sql: executor, calls };
}

function embedding(): number[] {
  return Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, index) => (index === 0 ? 1 : 0));
}

const documents = [
  { id: documentId, dataset_id: datasetId, title: "Contract", source_uri: "file://contract.pdf" },
];

describe("hybrid search index", () => {
  it("runs both rankings inside one transaction with ef_search set to the pilot value", async () => {
    const { sql, calls } = createRecordingSql({ vector: [chunkRow("a", 0, 0.9)], fullText: [chunkRow("a", 0, 0.4)] });
    const index = createPostgresSearchIndex({ sql });

    await index.search({ companyId, datasetId, queryText: "supply agreement", embedding: embedding() });

    const settings = calls.filter((call) => /set local hnsw\.ef_search/i.test(call.text));
    expect(settings).toHaveLength(1);
    expect(settings[0].text).toBe("set local hnsw.ef_search = 64");
    const vectorCall = calls.find((call) => /<=>/.test(call.text));
    const textCall = calls.find((call) => /ts_rank/.test(call.text));
    expect(vectorCall).toBeDefined();
    expect(textCall).toBeDefined();
    expect(vectorCall?.text).toContain('from "corpus_chunks" c');
    expect(vectorCall?.text).toContain("c.company_id = $2::uuid");
    expect(vectorCall?.text).toContain("c.dataset_id = $3::uuid");
    expect(vectorCall?.values).toEqual([expect.stringContaining("["), companyId, datasetId, 100]);
    expect(textCall?.text).toContain("plainto_tsquery($5::regconfig, $1)");
    expect(textCall?.values).toEqual(["supply agreement", companyId, datasetId, "%supply agreement%", "russian", 100]);
  });

  it("merges the rankings with RRF and returns score, chunk and document", async () => {
    const { sql } = createRecordingSql({
      vector: [chunkRow("a", 0, 0.9), chunkRow("b", 1, 0.8)],
      fullText: [chunkRow("b", 1, 0.5), chunkRow("a", 0, 0.4)],
      documents,
    });
    const index = createPostgresSearchIndex({ sql });

    const hits = await index.search({ companyId, datasetId, queryText: "contract", embedding: embedding(), limit: 2 });

    expect(hits.map((hit) => hit.chunk.id)).toEqual(["a", "b"]);
    expect(hits[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(hits[0].chunk).toEqual({
      id: "a",
      companyId,
      datasetId,
      documentId,
      ordinal: 0,
      content: "chunk a",
    });
    expect(hits[0].document).toEqual({
      id: documentId,
      datasetId,
      title: "Contract",
      sourceUri: "file://contract.pdf",
    });
    expect(hits[0].fusion).toEqual({ vectorRank: 1, fullTextRank: 2 });
    expect(hits[1].fusion).toEqual({ vectorRank: 2, fullTextRank: 1 });
  });

  it("takes kCandidates rows from each ranking and returns only the requested limit", async () => {
    const { sql, calls } = createRecordingSql({
      vector: [chunkRow("a", 0, 1), chunkRow("b", 1, 1)],
      fullText: [],
      documents,
    });
    const index = createPostgresSearchIndex({ sql });

    const hits = await index.search({ companyId, datasetId, queryText: "x", embedding: embedding(), limit: 1 });

    expect(hits.map((hit) => hit.chunk.id)).toEqual(["a"]);
    const vectorCall = calls.find((call) => /<=>/.test(call.text));
    expect(vectorCall?.values[3]).toBe(100);
    const textCall = calls.find((call) => /ts_rank/.test(call.text));
    expect(textCall?.values[5]).toBe(100);
  });

  it("honours a kCandidates above the default limit", async () => {
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [], documents: [] });
    const index = createPostgresSearchIndex({ sql, fusion: { k0: 60, kCandidates: 250 } });
    await index.search({ companyId, datasetId, queryText: "x", embedding: embedding(), limit: 10 });
    expect(calls.find((call) => /<=>/.test(call.text))?.values[3]).toBe(250);
  });

  it("returns nothing and skips the document query when both rankings are empty", async () => {
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [] });
    const index = createPostgresSearchIndex({ sql });
    expect(await index.search({ companyId, datasetId, queryText: "missing", embedding: embedding() })).toEqual([]);
    expect(calls.some((call) => /select d\.id/.test(call.text))).toBe(false);
  });

  it("skips candidates whose document row is missing", async () => {
    const { sql } = createRecordingSql({ vector: [chunkRow("a", 0, 1)], fullText: [], documents: [] });
    const index = createPostgresSearchIndex({ sql });
    expect(await index.search({ companyId, datasetId, queryText: "x", embedding: embedding() })).toEqual([]);
  });

  it("escapes wildcards of the trigram fallback pattern", async () => {
    expect(escapeLikePattern("100%_done\\")).toBe("100\\%\\_done\\\\");
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [] });
    const index = createPostgresSearchIndex({ sql });
    await index.search({ companyId, datasetId, queryText: "50% off", embedding: embedding() });
    expect(calls.find((call) => /ts_rank/.test(call.text))?.values[3]).toBe("%50\\% off%");
  });

  it("rejects a query embedding of the wrong shape and a bad limit", async () => {
    const { sql } = createRecordingSql({ vector: [], fullText: [] });
    const index = createPostgresSearchIndex({ sql });
    await expect(
      index.search({ companyId, datasetId, queryText: "x", embedding: [1, 2, 3] }),
    ).rejects.toThrow(/1024/);
    await expect(
      index.search({ companyId, datasetId, queryText: "x", embedding: embedding(), limit: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("refuses schema names and settings that are not valid identifiers", () => {
    const { sql } = createRecordingSql({ vector: [], fullText: [] });
    expect(() => createPostgresSearchIndex({ sql, schema: { chunksTable: "corpus_chunks; drop table x" } as never })).toThrow(
      RangeError,
    );
    expect(() => createPostgresSearchIndex({ sql, efSearch: 0 })).toThrow(RangeError);
    expect(() => createPostgresSearchIndex({ sql, ftsLanguage: "russian'--" })).toThrow(RangeError);
  });
});