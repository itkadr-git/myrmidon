import { describe, expect, it } from "vitest";

import {
  CorpusVectorSearchUnavailableError,
  createPostgresSearchIndex,
  escapeLikePattern,
  pgvectorHasIterativeScan,
  type SqlExecutor,
} from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
const documentId = "cccccccc-0000-0000-0000-000000000003";
const secondDocumentId = "cccccccc-0000-0000-0000-000000000004";

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

function chunkRow(id: string, chunkIndex: number, score: number, rowDocumentId = documentId): ChunkRow {
  return {
    id,
    company_id: companyId,
    document_id: rowDocumentId,
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
    if (/pg_extension/.test(text)) return [{ extversion: "0.8.7" }];
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
  { id: secondDocumentId, dataset_id: datasetId, title: "Second", source_uri: "file://second.pdf" },
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
    expect(vectorCall?.text).toContain("($3::uuid[] is null or d.dataset_id = any($3::uuid[]))");
    expect(vectorCall?.text).toContain("d.status = 'ready'");
    expect(vectorCall?.text).toContain('order by c."embedding" <=> $1::vector');
    expect(vectorCall?.values).toEqual([expect.stringContaining("["), companyId, [datasetId], 100]);
    expect(textCall?.text).toContain('c."fts"');
    expect(textCall?.text).toContain("plainto_tsquery($5::regconfig, $1)");
    expect(textCall?.text).toContain('c."content" ilike $4');
    expect(textCall?.values).toEqual(["supply agreement", companyId, [datasetId], "%supply agreement%", "english", 100]);
  });

  it("merges the rankings with RRF and returns score, chunk and document", async () => {
    const { sql } = createRecordingSql({
      vector: [chunkRow("a", 0, 0.9), chunkRow("b", 1, 0.8, secondDocumentId)],
      fullText: [chunkRow("b", 1, 0.5, secondDocumentId), chunkRow("a", 0, 0.4)],
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

  it("diversifies top-k by document instead of returning adjacent chunks from one document", async () => {
    const { sql } = createRecordingSql({
      vector: [
        chunkRow("a1", 0, 0.9),
        chunkRow("a2", 1, 0.8),
        chunkRow("b1", 0, 0.7, secondDocumentId),
      ],
      fullText: [],
      documents,
    });
    const index = createPostgresSearchIndex({ sql });

    const hits = await index.search({ companyId, datasetId, text: "contract", embedding: embedding(), limit: 2 });

    expect(hits.map((hit) => hit.chunkId)).toEqual(["a1", "b1"]);
    expect(new Set(hits.map((hit) => hit.documentId)).size).toBe(2);
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

  it('searches multiple datasets when datasetIds is given', async () => {
    const { sql, calls } = createRecordingSql({ vector: [chunkRow('a', 0, 1)], fullText: [], documents });
    const index = createPostgresSearchIndex({ sql });

    const hits = await index.search({ companyId, datasetIds: ['id-1', 'id-2'], text: 'contract', embedding: embedding() });

    expect(hits.map((hit) => hit.chunkId)).toEqual(['a']);
    expect(calls.find((call) => /<=>/.test(call.text))?.values[2]).toEqual(['id-1', 'id-2']);
    expect(calls.find((call) => /ts_rank/.test(call.text))?.values[2]).toEqual(['id-1', 'id-2']);
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
    expect((error as Error).message).toMatch(/0391_corpus_pgvector/);
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

  it("refuses an ilike limit that is not a non-negative integer", () => {
    const { sql } = createRecordingSql({ vector: [], fullText: [] });
    expect(() => createPostgresSearchIndex({ sql, ilikeMaxLength: -1 })).toThrow(RangeError);
    expect(() => createPostgresSearchIndex({ sql, ilikeMaxLength: 1.5 })).toThrow(RangeError);
    expect(() => createPostgresSearchIndex({ sql, exactSetMaxChunks: -1 })).toThrow(RangeError);
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

// OPE-12034: the vector ranking runs with the HNSW iterative scan (a small dataset is ranked exactly);
// the full-text ranking adds the substring match only for short query texts.
interface ScriptedCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Executor that records every statement and lets the test answer, or fail, each one. */
function createScriptedSql(respond: (call: ScriptedCall) => unknown[]): { sql: SqlExecutor; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const executor: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      const call = { text, values };
      calls.push(call);
      return respond(call) as Row[];
    },
    withTransaction: (callback) => callback(executor),
  };
  return { sql: executor, calls };
}

function manyChunkRows(count: number, prefix: string): ChunkRow[] {
  return Array.from({ length: count }, (_, position) => chunkRow(`${prefix}${position}`, position, 1 - position / 1000));
}

const isSizeProbe = (call: ScriptedCall) => /count\(\*\)::int as chunks/.test(call.text);
const isExact = (call: ScriptedCall) => /<=>/.test(call.text) && /\+ 0/.test(call.text);
const isIndexRanking = (call: ScriptedCall) => /<=>/.test(call.text) && !isExact(call);
const isIterativeScan = (call: ScriptedCall) => /set local hnsw\.iterative_scan/.test(call.text);

/** Answers like a database with pgvector `version`; `index` and `exact` are the rows of the rankings. */
function scripted(answers: {
  version?: string | null;
  /** Chunks the size probe of the requested datasets counts; omitted, the probe answers no row. */
  size?: number;
  index?: ChunkRow[];
  exact?: ChunkRow[];
}): (call: ScriptedCall) => unknown[] {
  const version = answers.version === undefined ? "0.8.7" : answers.version;
  return (call) => {
    if (/pg_extension/.test(call.text)) return version === null ? [] : [{ extversion: version }];
    if (isSizeProbe(call)) return answers.size === undefined ? [] : [{ chunks: answers.size }];
    if (isExact(call)) return answers.exact ?? [];
    if (isIndexRanking(call)) return answers.index ?? [];
    if (/select d\.id/.test(call.text)) return documents;
    return [];
  };
}

describe("vector ranking through the HNSW iterative scan", () => {
  it("reads the pgvector version, turns the iterative scan on, sizes the dataset, then ranks through the index", async () => {
    const { sql, calls } = createScriptedSql(scripted({ size: 50_000, index: manyChunkRows(100, "v") }));
    await createPostgresSearchIndex({ sql }).search({ companyId, datasetId, embedding: embedding() });

    expect(calls.map((call) => call.text).slice(0, 6)).toEqual([
      "set local hnsw.ef_search = 64",
      "select extversion from pg_extension where extname = 'vector'",
      "set local hnsw.iterative_scan = relaxed_order",
      "set local hnsw.max_scan_tuples = 100000",
      expect.stringContaining("select count(*)::int as chunks"),
      expect.stringContaining('order by c."embedding" <=> $1::vector'),
    ]);
    expect(calls.filter(isExact)).toHaveLength(0);
    expect(calls.find(isIndexRanking)?.values).toEqual([expect.any(String), companyId, [datasetId], 100]);
  });

  it("keeps a positive pgvector answer for the life of the index", async () => {
    const { sql, calls } = createScriptedSql(scripted({ size: 50_000, index: manyChunkRows(100, "v") }));
    const index = createPostgresSearchIndex({ sql });
    await index.search({ companyId, datasetId, embedding: embedding() });
    await index.search({ companyId, datasetId, embedding: embedding() });

    expect(calls.filter((call) => /pg_extension/.test(call.text))).toHaveLength(1);
    expect(calls.filter(isIterativeScan)).toHaveLength(2);
    expect(calls.filter(isIndexRanking)).toHaveLength(2);
  });

  it("does not keep a negative pgvector answer: an extension installed later is seen by the next search", async () => {
    let version: string | null = null;
    const { sql, calls } = createScriptedSql((call) => scripted({ version, size: 50_000, index: manyChunkRows(100, "v") })(call));
    const index = createPostgresSearchIndex({ sql });

    await index.search({ companyId, datasetId, embedding: embedding() });
    expect(calls.filter(isIterativeScan)).toHaveLength(0);
    expect(calls.filter(isIndexRanking)).toHaveLength(1);

    version = "0.8.7";
    await index.search({ companyId, datasetId, embedding: embedding() });
    expect(calls.filter((call) => /pg_extension/.test(call.text))).toHaveLength(2);
    expect(calls.filter(isIterativeScan)).toHaveLength(1);
    expect(calls.filter(isSizeProbe)).toHaveLength(1);
  });

  it("orders the rows of the relaxed scan by score before the fusion ranks them", async () => {
    // The relaxed iterative scan returns the rows slightly out of order: b is nearer than a.
    const rows = [chunkRow("a", 0, 0.8), chunkRow("b", 1, 0.9, secondDocumentId), chunkRow("c", 2, 0.7, "cccccccc-0000-0000-0000-000000000005")];
    const { sql } = createScriptedSql(scripted({ size: 50_000, index: rows }));
    const hits = await createPostgresSearchIndex({ sql }).search({
      companyId,
      datasetId,
      embedding: embedding(),
      limit: 3,
    });

    expect(hits.map((hit) => hit.fusion.vectorRank)).toEqual([1, 2, 3].slice(0, hits.length));
    expect(hits[0]?.chunkId).toBe("b");
  });

  it("returns what a large dataset has, with no exact ranking, when the scan fills fewer than kCandidates", async () => {
    const { sql, calls } = createScriptedSql(scripted({ size: 50_000, index: [chunkRow("only", 0, 0.9)], exact: manyChunkRows(100, "x") }));
    const hits = await createPostgresSearchIndex({ sql }).search({ companyId, datasetIds: [datasetId], embedding: embedding() });

    expect(calls.filter(isExact)).toHaveLength(0);
    expect(calls.filter(isIndexRanking)).toHaveLength(1);
    expect(hits.map((hit) => hit.chunkId)).toEqual(["only"]);
  });

  it("does not probe or rank exactly a search without a dataset", async () => {
    const { sql, calls } = createScriptedSql(scripted({ size: 5, index: [chunkRow("only", 0, 0.9)] }));
    const hits = await createPostgresSearchIndex({ sql }).search({ companyId, embedding: embedding() });

    expect(calls.filter(isSizeProbe)).toHaveLength(0);
    expect(calls.filter(isExact)).toHaveLength(0);
    expect(calls.filter(isIterativeScan)).toHaveLength(1);
    expect(calls.find(isIndexRanking)?.values[2]).toBeNull();
    expect(hits.map((hit) => hit.chunkId)).toEqual(["only"]);
  });

  it("ranks a small dataset exactly at once, through the exact statement", async () => {
    const { sql, calls } = createScriptedSql(
      scripted({ size: 500, index: manyChunkRows(100, "index"), exact: [chunkRow("exact-1", 0, 0.8), chunkRow("exact-2", 1, 0.7, secondDocumentId)] }),
    );
    const hits = await createPostgresSearchIndex({ sql }).search({ companyId, datasetIds: [datasetId], embedding: embedding() });

    const probe = calls.find(isSizeProbe);
    expect(probe?.text).toContain("d.dataset_id = any($2::uuid[])");
    expect(probe?.text).toContain("limit $3");
    expect(probe?.values).toEqual([companyId, [datasetId], 10_001]);
    expect(calls.filter(isIndexRanking)).toHaveLength(0);
    const exact = calls.find(isExact);
    expect(exact?.text).toContain('order by (c."embedding" <=> $1::vector) + 0');
    expect(exact?.text).toContain("($3::uuid[] is null or d.dataset_id = any($3::uuid[]))");
    expect(exact?.values).toEqual([expect.any(String), companyId, [datasetId], 100]);
    expect(calls.findIndex(isExact)).toBeGreaterThan(calls.findIndex(isSizeProbe));
    expect(hits.map((hit) => hit.chunkId)).toEqual(["exact-1", "exact-2"]);
  });

  it("sends a dataset through the index when it is larger than exactSetMaxChunks", async () => {
    for (const [size, small] of [
      [10_000, true],
      [10_001, false],
    ] as const) {
      const { sql, calls } = createScriptedSql(scripted({ size, index: manyChunkRows(100, "v") }));
      await createPostgresSearchIndex({ sql }).search({ companyId, datasetIds: [datasetId], embedding: embedding() });
      expect(calls.filter(isIndexRanking)).toHaveLength(small ? 0 : 1);
      expect(calls.filter(isExact)).toHaveLength(small ? 1 : 0);
    }
  });

  it("honours exactSetMaxChunks, and 0 sends every dataset through the index without a probe", async () => {
    const custom = createScriptedSql(scripted({ size: 300, index: manyChunkRows(100, "v") }));
    await createPostgresSearchIndex({ sql: custom.sql, exactSetMaxChunks: 200 }).search({
      companyId,
      datasetIds: [datasetId],
      embedding: embedding(),
    });
    expect(custom.calls.find(isSizeProbe)?.values[2]).toBe(201);
    expect(custom.calls.filter(isIndexRanking)).toHaveLength(1);

    const off = createScriptedSql(scripted({ size: 5, index: manyChunkRows(100, "v") }));
    await createPostgresSearchIndex({ sql: off.sql, exactSetMaxChunks: 0 }).search({
      companyId,
      datasetIds: [datasetId],
      embedding: embedding(),
    });
    expect(off.calls.filter(isSizeProbe)).toHaveLength(0);
    expect(off.calls.filter(isExact)).toHaveLength(0);
    expect(off.calls.filter(isIndexRanking)).toHaveLength(1);
  });

  it("sets hnsw.max_scan_tuples right after the iterative scan: 100 000 by default, the option otherwise", async () => {
    const byDefault = createScriptedSql(scripted({ size: 50_000, index: manyChunkRows(100, "v") }));
    await createPostgresSearchIndex({ sql: byDefault.sql }).search({ companyId, datasetId, embedding: embedding() });
    const defaultTexts = byDefault.calls.map((call) => call.text);
    expect(defaultTexts.indexOf("set local hnsw.max_scan_tuples = 100000")).toBe(
      defaultTexts.indexOf("set local hnsw.iterative_scan = relaxed_order") + 1,
    );

    const withLimit = createScriptedSql(scripted({ size: 50_000, index: manyChunkRows(100, "v") }));
    await createPostgresSearchIndex({ sql: withLimit.sql, maxScanTuples: 60_000 }).search({
      companyId,
      datasetId,
      embedding: embedding(),
    });
    expect(withLimit.calls.some((call) => call.text === "set local hnsw.max_scan_tuples = 60000")).toBe(true);

    const { sql } = createScriptedSql(scripted({}));
    expect(() => createPostgresSearchIndex({ sql, maxScanTuples: 0 })).toThrow(RangeError);
  });

  for (const version of ["0.7.4", "0.5.1", null]) {
    it(`uses the plain statement where pgvector has no iterative scan (${version ?? "no vector extension"})`, async () => {
      const { sql, calls } = createScriptedSql(scripted({ version, size: 5, index: [chunkRow("plain", 0, 0.9)] }));
      const hits = await createPostgresSearchIndex({ sql }).search({ companyId, datasetId, embedding: embedding() });

      // No statement the old extension would refuse: the settings are never sent, so the transaction
      // is never aborted and nothing has to be rolled back. No probe either: the plain statement is
      // what these versions always ran.
      expect(calls.some((call) => /hnsw\.(iterative_scan|max_scan_tuples)/.test(call.text))).toBe(false);
      expect(calls.filter(isSizeProbe)).toHaveLength(0);
      expect(calls.filter(isExact)).toHaveLength(0);
      const plain = calls.find(isIndexRanking);
      expect(plain?.text).toContain("d.dataset_id = any($3::uuid[])");
      expect(plain?.text).toContain('order by c."embedding" <=> $1::vector');
      expect(plain?.values).toEqual([expect.any(String), companyId, [datasetId], 100]);
      expect(calls.map((call) => call.text)[0]).toBe("set local hnsw.ef_search = 64");
      expect(hits.map((hit) => hit.chunkId)).toEqual(["plain"]);
    });
  }

  it("does not hide a failed iterative scan setting behind the fallback", async () => {
    const answer = scripted({});
    const { sql } = createScriptedSql((call) => {
      if (isIterativeScan(call)) {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }
      return answer(call);
    });
    const error = await createPostgresSearchIndex({ sql })
      .search({ companyId, datasetId, embedding: embedding() })
      .then(() => null, (thrown: unknown) => thrown);

    expect((error as Error).message).toMatch(/deadlock/);
    expect(error).not.toBeInstanceOf(CorpusVectorSearchUnavailableError);
  });

  it("reads the iterative scan from pgvector 0.8.0 on", () => {
    for (const version of ["0.8.0", "0.8.7", "0.9.1", "1.0.0", " 0.8.2 "]) {
      expect(pgvectorHasIterativeScan(version)).toBe(true);
    }
    for (const version of ["0.7.4", "0.7.0", "0.4.4", "", "garbage", null, undefined]) {
      expect(pgvectorHasIterativeScan(version)).toBe(false);
    }
  });
});

describe("substring match of the full-text ranking", () => {
  /** A text of exactly `length` characters made of words separated by single spaces. */
  const phrase = (length: number) => "aaaaaaa ".repeat(Math.ceil(length / 8)).slice(0, length).trimEnd().padEnd(length, "b");
  const ilikeUsed = async (text: string, options: { ilikeMaxLength?: number } = {}) => {
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [chunkRow("t", 0, 0.3)], documents });
    await createPostgresSearchIndex({ sql, ...options }).search({ companyId, datasetId, text });
    return /ilike/.test(calls.find((call) => /ts_rank/.test(call.text))?.text ?? "");
  };

  it("adds the ilike match up to the limit and drops it for a longer text with spaces", async () => {
    expect(phrase(16)).toHaveLength(16);
    expect(phrase(17)).toHaveLength(17);
    expect(await ilikeUsed(phrase(16))).toBe(true);
    expect(await ilikeUsed(phrase(17))).toBe(false);
    expect(await ilikeUsed("как оформить командировку и авансовый отчёт")).toBe(false);
  });

  it("keeps the ilike match for an identifier: a single token without whitespace of up to 64 characters", async () => {
    // File names, versions and task codes: the tsvector does not find `litellm_proxy_config` in
    // `litellm_proxy_config.yaml`, the ilike does.
    for (const identifier of [
      "litellm_proxy_config",
      "rq002_is_camp_chef_explorer",
      "docker-compose-override",
      "v1.6.6-rc.45-build",
      "x".repeat(64),
    ]) {
      expect(await ilikeUsed(identifier)).toBe(true);
    }
    expect(await ilikeUsed("x".repeat(65))).toBe(false);
    // A question of 40 characters with spaces stays without it, and so does a token with a tab or a line break.
    expect(await ilikeUsed(phrase(40))).toBe(false);
    expect(await ilikeUsed("litellm_proxy_config\tyaml_file_name")).toBe(false);
    expect(await ilikeUsed("litellm_proxy_config\nyaml_file_name")).toBe(false);
  });

  it("escapes the wildcards of an identifier in the ilike pattern", async () => {
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [chunkRow("t", 0, 0.3)], documents });
    await createPostgresSearchIndex({ sql }).search({ companyId, datasetId, text: "rq002_is_camp_chef_explorer" });
    expect(calls.find((call) => /ts_rank/.test(call.text))?.values[3]).toBe("%rq002\\_is\\_camp\\_chef\\_explorer%");
  });

  it("runs the text-only statement with renumbered parameters", async () => {
    const { sql, calls } = createRecordingSql({ vector: [], fullText: [chunkRow("t", 0, 0.3)], documents });
    const longText = "how do I light the charcoal in the grill";
    await createPostgresSearchIndex({ sql }).search({ companyId, datasetId, text: `  ${longText}  ` });

    const textCall = calls.find((call) => /ts_rank/.test(call.text));
    expect(textCall?.text).toContain("plainto_tsquery($4::regconfig, $1)");
    expect(textCall?.text).toContain("limit $5");
    expect(textCall?.text).not.toMatch(/ilike|\$6/);
    // Every parameter the text names is bound, and no other: a driver rejects a gap.
    expect(textCall?.values).toEqual([longText, companyId, [datasetId], "english", 100]);
    const named = new Set([...(textCall?.text.matchAll(/\$(\d+)/g) ?? [])].map((match) => Number(match[1])));
    expect([...named].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("honours ilikeMaxLength, and 0 switches the match off", async () => {
    const wide = createRecordingSql({ vector: [], fullText: [chunkRow("t", 0, 0.3)], documents });
    await createPostgresSearchIndex({ sql: wide.sql, ilikeMaxLength: 40 }).search({ companyId, datasetId, text: phrase(30) });
    expect(wide.calls.find((call) => /ts_rank/.test(call.text))?.text).toContain("ilike");

    // 0 switches the match off for every text, identifiers too.
    expect(await ilikeUsed("a", { ilikeMaxLength: 0 })).toBe(false);
    expect(await ilikeUsed("litellm_proxy_config", { ilikeMaxLength: 0 })).toBe(false);
  });
});
