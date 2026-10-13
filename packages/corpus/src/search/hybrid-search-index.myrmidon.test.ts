import { describe, expect, it } from "vitest";

import { CorpusVectorSearchUnavailableError, createPostgresSearchIndex, escapeLikePattern, type SqlExecutor } from "./hybrid-search-index.js";
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
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  metadata: Record<string, unknown>;
  score: number;
}

function chunkRow(id: string, chunkIndex: number, score: number): ChunkRow {
  return {
    id,
    company_id: companyId,
    document_id: documentId,
    chunk_index: chunkIndex,
    content: `chunk ${id}`,
    token_count: 12,
    metadata: { pageNumber: chunkIndex + 1 },
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

/** A cluster migrated without pgvector: every call to the vector leg fails with a driver code. */
function createPgvectorMissingSql(
  code: string,
  message: string,
  rows: { fullText?: ChunkRow[]; documents?: unknown[] } = {},
): { sql: SqlExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(text: string): Promise<Row[]> => {
      calls.push(text);
      if (/set local hnsw\.ef_search/i.test(text) || /<=>/.test(text)) {
        throw Object.assign(new Error(message), { code });
      }
      if (/ts_rank/.test(text)) return (rows.fullText ?? []) as unknown as Row[];
      if (/select d\.id/.test(text)) return (rows.documents ?? []) as unknown as Row[];
      return [];
    },
    withTransaction: (callback) => callback(executor),
  };
  return { sql: executor, calls };
}

describe("hybrid search index", () => {
  it("runs both rankings inside one transaction with ef_search set to the pilot value", async () => {
    const { sql, calls } = createRecordingSql({ vector: [chunkRow("a", 0, 0.9)], fullText: [chunkRow("a", 0, 0.4)] });
    const index = createPostgresSearchIndex({ sql });

    await index.search({ companyId, datasetId, text: "supply agreement", embedding: embedding() });

    const settings = calls.filter((call) => /set local hnsw\.ef_search/i.test(call.text));
    expect(settings).toHaveLength(1);
    expect(settings[0].text).toBe("set local hnsw.ef_search = 64");
    const vectorCall = calls.find((call) => /<=>/.test(call.text));
    const textCall = calls.find((call) => /ts_rank/.test(call.text));
    expect(vectorCall).toBeDefined();
    expect(textCall).toBeDefined();
    expect(vectorCall?.text).toContain('from "corpus_chunks" c');
    expect(vectorCall?.text).toContain('join "corpus_documents" d on d.id = c.document_id and d.company_id = c.company_id');
    expect(vectorCall?.text).toContain("c.company_id = $2::uuid");
    expect(vectorCall?.text).toContain("($3::uuid is null or d.dataset_id = $3::uuid)");
    expect(vectorCall?.text).toContain("d.status = 'ready'");
    expect(vectorCall?.values).toEqual([expect.stringContaining("["), companyId, datasetId, 100]);
    expect(textCall?.text).toContain('c."fts"');
    expect(textCall?.text).toContain("plainto_tsquery($5::regconfig, $1)");
    expect(textCall?.text).toContain('c."content" ilike $4');
    expect(textCall?.values).toEqual(["supply agreement", companyId, datasetId, "%supply agreement%", "english", 100]);
  });

  it("merges the rankings with RRF and returns score, chunk and document", async () => {
    const { sql } = createRecordingSql({
      vector: [chunkRow("a", 0, 0.9), chunkRow("b", 1, 0.8)],
      fullText: [chunkRow("b", 1, 0.5), chunkRow("a", 0, 0.4)],
      documents,
    });
    const index = createPostgresSearchIndex({ sql });

    const hits = await index.search({ companyId, datasetId, text: "contract", embedding: embedding(), limit: 2 });

    expect(hits.map((hit) => hit.chunkId)).toEqual(["a", "b"]);
    expect(hits[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(hits[0]).toMatchObject({
      chunkId: "a",
      documentId,
      datasetId,
      content: "chunk a",
    });
    expect(hits[0].chunk).toEqual({
      id: "a",
      companyId,
      datasetId,
      documentId,
      chunkIndex: 0,
      content: "chunk a",
      tokenCount: 12,
      metadata: { pageNumber: 1 },
    });
    expect(hits[0].document).toEqual({
      id: documentId,
      datasetId,
      title: "Contract",
      sourceUri: "file://contract.pdf",
    });
    expect(hits[0].metadata).toEqual({ pageNumber: 1 });
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

    const hits = await index.search({ companyId, datasetId, text: "x", embedding: embedding(), limit: 1 });

    expect(hits.map((hit) => hit.chunkId)).toEqual(["a"]);
    const vectorCall = calls.find((call) => /<=>/.test(call.text));
    expect(vectorCall?.values[3]).toBe(100);
    const textCall = calls.find((call) => /ts_rank/.test(call.text));
    expect(textCall?.values[5]).toBe(100);
  });

  it("honours a kCandidates above the default limit", async () => {
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [], documents: [] });
    const index = createPostgresSearchIndex({ sql, fusion: { k0: 60, kCandidates: 250 } });
    await index.search({ companyId, datasetId, text: "x", embedding: embedding(), limit: 10 });
    expect(calls.find((call) => /<=>/.test(call.text))?.values[3]).toBe(250);
  });

  it("searches the whole company when no dataset is given", async () => {
    const { sql, calls } = createRecordingSql({ vector: [chunkRow("a", 0, 1)], fullText: [], documents });
    const index = createPostgresSearchIndex({ sql });

    const hits = await index.search({ companyId, text: "contract", embedding: embedding() });

    expect(hits.map((hit) => hit.chunkId)).toEqual(["a"]);
    expect(calls.find((call) => /<=>/.test(call.text))?.values[2]).toBeNull();
    expect(calls.find((call) => /ts_rank/.test(call.text))?.values[2]).toBeNull();
  });

  it("runs only the full text ranking when the query carries no embedding", async () => {
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [chunkRow("a", 0, 0.3)], documents });
    const index = createPostgresSearchIndex({ sql });

    const hits = await index.search({ companyId, datasetId, text: "contract" });

    expect(hits.map((hit) => hit.chunkId)).toEqual(["a"]);
    expect(hits[0].fusion).toEqual({ vectorRank: null, fullTextRank: 1 });
    expect(calls.some((call) => /<=>/.test(call.text))).toBe(false);
    expect(calls.some((call) => /set local hnsw\.ef_search/i.test(call.text))).toBe(false);
  });

  it("returns nothing without touching the database when the text is blank and no embedding is given", async () => {
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [] });
    const index = createPostgresSearchIndex({ sql });

    expect(await index.search({ companyId, datasetId, text: "   " })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns nothing and skips the document query when both rankings are empty", async () => {
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [] });
    const index = createPostgresSearchIndex({ sql });
    expect(await index.search({ companyId, datasetId, text: "missing", embedding: embedding() })).toEqual([]);
    expect(calls.some((call) => /select d\.id/.test(call.text))).toBe(false);
  });

  it("skips candidates whose document row is missing", async () => {
    const { sql } = createRecordingSql({ vector: [chunkRow("a", 0, 1)], fullText: [], documents: [] });
    const index = createPostgresSearchIndex({ sql });
    expect(await index.search({ companyId, datasetId, text: "x", embedding: embedding() })).toEqual([]);
  });

  it("keeps chunks as rows, so removing a document has nothing to invalidate", async () => {
    const { sql } = createRecordingSql({ vector: [], fullText: [] });
    const index = createPostgresSearchIndex({ sql });
    await expect(index.removeDocument(companyId, documentId)).resolves.toBeUndefined();
  });

  it("escapes wildcards of the trigram fallback pattern", async () => {
    expect(escapeLikePattern("100%_done\\")).toBe("100\\%\\_done\\\\");
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [] });
    const index = createPostgresSearchIndex({ sql });
    await index.search({ companyId, datasetId, text: "50% off", embedding: embedding() });
    expect(calls.find((call) => /ts_rank/.test(call.text))?.values[3]).toBe("%50\\% off%");
  });

  it("rejects a query embedding of the wrong shape and a bad limit", async () => {
    const { sql } = createRecordingSql({ vector: [], fullText: [] });
    const index = createPostgresSearchIndex({ sql });
    await expect(
      index.search({ companyId, datasetId, text: "x", embedding: [1, 2, 3] }),
    ).rejects.toThrow(/1024/);
    await expect(
      index.search({ companyId, datasetId, text: "x", embedding: embedding(), limit: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("reports a cluster without pgvector as the module's own error, keeping the driver error", async () => {
    const driverError = { code: "42703" };
    const { sql } = createPgvectorMissingSql("42703", 'column "embedding" does not exist');
    const index = createPostgresSearchIndex({ sql });

    const error = await index
      .search({ companyId, datasetId, text: "contract", embedding: embedding() })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CorpusVectorSearchUnavailableError);
    expect((error as CorpusVectorSearchUnavailableError).code).toBe("corpus_vector_search_unavailable");
    expect((error as Error).message).toMatch(/0310_corpus_pgvector/);
    expect((error as Error).message).toMatch(/full text search is available/);
    expect((error as CorpusVectorSearchUnavailableError).pgError).toMatchObject(driverError);
  });

  it("keeps full text search working on a cluster without pgvector", async () => {
    const { sql, calls } = createPgvectorMissingSql("42704", "unrecognized configuration parameter", {
      fullText: [chunkRow("a", 0, 0.3)],
      documents,
    });
    const index = createPostgresSearchIndex({ sql });

    const hits = await index.search({ companyId, datasetId, text: "contract" });

    expect(hits.map((hit) => hit.chunkId)).toEqual(["a"]);
    expect(hits[0].fusion).toEqual({ vectorRank: null, fullTextRank: 1 });
    expect(calls.some((call) => /<=>|hnsw\.ef_search/i.test(call))).toBe(false);
  });

  it("does not dress an unrelated database failure as a pgvector problem", async () => {
    const { sql } = createPgvectorMissingSql("40P01", "deadlock detected while ranking chunks");
    const index = createPostgresSearchIndex({ sql });

    const error = await index
      .search({ companyId, datasetId, text: "contract", embedding: embedding() })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(CorpusVectorSearchUnavailableError);
    expect((error as Error).message).toMatch(/deadlock/);
  });

  it("refuses schema names and settings that are not valid identifiers", () => {
    const { sql } = createRecordingSql({ vector: [], fullText: [] });
    expect(() => createPostgresSearchIndex({ sql, schema: { chunksTable: "corpus_chunks; drop table x" } as never })).toThrow(
      RangeError,
    );
    expect(() => createPostgresSearchIndex({ sql, efSearch: 0 })).toThrow(RangeError);
    expect(() => createPostgresSearchIndex({ sql, ftsLanguage: "english'--" })).toThrow(RangeError);
  });
});