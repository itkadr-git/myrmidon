import { describe, expect, it } from "vitest";

import {
  CorpusVectorSearchUnavailableError,
  DEFAULT_SEARCH_INDEX_SCHEMA,
  createPostgresSearchIndex,
  escapeLikePattern,
  pgvectorHasIterativeScan,
  toFullTextQuery,
  type FullTextTimeoutEvent,
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
  it("runs both rankings with ef_search set to the pilot value", async () => {
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
    // The question as a whole (every word mandatory) joined with the OR of its significant words.
    expect(textCall?.text).toContain("plainto_tsquery($5::regconfig, $1)");
    expect(textCall?.text).toContain("to_tsquery($5::regconfig, $7)");
    expect(textCall?.text).toContain("case when $7 = ''");
    expect(textCall?.text).toContain("similarity(c.\"content\", $1)");
    expect(textCall?.text).toContain('c."content" ilike $4');
    expect(textCall?.values).toEqual([
      "supply agreement",
      companyId,
      [datasetId],
      "%supply agreement%",
      "english",
      100,
      "supply | agreement",
    ]);
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

  it("builds a bounded OR of significant words for the full-text query", () => {
    // The `|` of the OR and the dictionary come together in the statement; the builder only
    // tokenizes, so no `to_tsquery` operator from the user text can leak into the query.
    expect(toFullTextQuery("Какой гриль лучше для стейка?")).toBe("гриль | лучше | стейка");
    expect(toFullTextQuery("supply agreement")).toBe("supply | agreement");
    // Short words and stop words are dropped; duplicates collapse.
    expect(toFullTextQuery("Как say: what is the data in the data of the data?")).toBe("data");
    // At most 8 terms keep the GIN scan bounded.
    expect(toFullTextQuery("один два три четыре пять шесть семь восемь девять десять").split(" | ")).toHaveLength(8);
    // Only whitespace or stop words — an empty query, the leg is skipped downstream.
    expect(toFullTextQuery("как что и")).toBe("");
    // tsquery operators and quotes in the user text cannot survive tokenization.
    expect(toFullTextQuery("a & b | c ! (d)")).toBe("");
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
    await createPostgresSearchIndex({ sql }).search({ text: "", companyId, datasetId, embedding: embedding() });

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
    await index.search({ text: "", companyId, datasetId, embedding: embedding() });
    await index.search({ text: "", companyId, datasetId, embedding: embedding() });

    expect(calls.filter((call) => /pg_extension/.test(call.text))).toHaveLength(1);
    expect(calls.filter(isIterativeScan)).toHaveLength(2);
    expect(calls.filter(isIndexRanking)).toHaveLength(2);
  });

  it("does not keep a negative pgvector answer: an extension installed later is seen by the next search", async () => {
    let version: string | null = null;
    const { sql, calls } = createScriptedSql((call) => scripted({ version, size: 50_000, index: manyChunkRows(100, "v") })(call));
    const index = createPostgresSearchIndex({ sql });

    await index.search({ text: "", companyId, datasetId, embedding: embedding() });
    expect(calls.filter(isIterativeScan)).toHaveLength(0);
    expect(calls.filter(isIndexRanking)).toHaveLength(1);

    version = "0.8.7";
    await index.search({ text: "", companyId, datasetId, embedding: embedding() });
    expect(calls.filter((call) => /pg_extension/.test(call.text))).toHaveLength(2);
    expect(calls.filter(isIterativeScan)).toHaveLength(1);
    expect(calls.filter(isSizeProbe)).toHaveLength(1);
  });

  it("orders the rows of the relaxed scan by score before the fusion ranks them", async () => {
    // The relaxed iterative scan returns the rows slightly out of order: b is nearer than a.
    const rows = [chunkRow("a", 0, 0.8), chunkRow("b", 1, 0.9, secondDocumentId), chunkRow("c", 2, 0.7, "cccccccc-0000-0000-0000-000000000005")];
    const { sql } = createScriptedSql(scripted({ size: 50_000, index: rows }));
    const hits = await createPostgresSearchIndex({ sql }).search({
      text: "",
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
    const hits = await createPostgresSearchIndex({ sql }).search({ text: "", companyId, datasetIds: [datasetId], embedding: embedding() });

    expect(calls.filter(isExact)).toHaveLength(0);
    expect(calls.filter(isIndexRanking)).toHaveLength(1);
    expect(hits.map((hit) => hit.chunkId)).toEqual(["only"]);
  });

  it("probes the company of a search without a dataset: a large company goes through the index", async () => {
    const { sql, calls } = createScriptedSql(scripted({ size: 50_000, index: [chunkRow("only", 0, 0.9)] }));
    const hits = await createPostgresSearchIndex({ sql }).search({ text: "", companyId, embedding: embedding() });

    expect(calls.find(isSizeProbe)?.values).toEqual([companyId, null, 10_001]);
    expect(calls.find(isSizeProbe)?.text).toContain("($2::uuid[] is null or d.dataset_id = any($2::uuid[]))");
    expect(calls.filter(isExact)).toHaveLength(0);
    expect(calls.filter(isIterativeScan)).toHaveLength(1);
    expect(calls.find(isIndexRanking)?.values[2]).toBeNull();
    expect(hits.map((hit) => hit.chunkId)).toEqual(["only"]);
  });

  it("ranks a small company exactly when the search names no dataset", async () => {
    const { sql, calls } = createScriptedSql(
      scripted({ size: 2_000, index: manyChunkRows(100, "index"), exact: [chunkRow("exact-1", 0, 0.8)] }),
    );
    const hits = await createPostgresSearchIndex({ sql }).search({ text: "", companyId, embedding: embedding() });

    expect(calls.filter(isIndexRanking)).toHaveLength(0);
    expect(calls.find(isExact)?.values).toEqual([expect.any(String), companyId, null, 100]);
    expect(hits.map((hit) => hit.chunkId)).toEqual(["exact-1"]);
  });

  it("ranks a small dataset exactly at once, through the exact statement", async () => {
    const { sql, calls } = createScriptedSql(
      scripted({ size: 500, index: manyChunkRows(100, "index"), exact: [chunkRow("exact-1", 0, 0.8), chunkRow("exact-2", 1, 0.7, secondDocumentId)] }),
    );
    const hits = await createPostgresSearchIndex({ sql }).search({ text: "", companyId, datasetIds: [datasetId], embedding: embedding() });

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
      await createPostgresSearchIndex({ sql }).search({ text: "", companyId, datasetIds: [datasetId], embedding: embedding() });
      expect(calls.filter(isIndexRanking)).toHaveLength(small ? 0 : 1);
      expect(calls.filter(isExact)).toHaveLength(small ? 1 : 0);
    }
  });

  it("honours exactSetMaxChunks, and 0 sends every dataset through the index without a probe", async () => {
    const custom = createScriptedSql(scripted({ size: 300, index: manyChunkRows(100, "v") }));
    await createPostgresSearchIndex({ sql: custom.sql, exactSetMaxChunks: 200 }).search({
      text: "",
      companyId,
      datasetIds: [datasetId],
      embedding: embedding(),
    });
    expect(custom.calls.find(isSizeProbe)?.values[2]).toBe(201);
    expect(custom.calls.filter(isIndexRanking)).toHaveLength(1);

    const off = createScriptedSql(scripted({ size: 5, index: manyChunkRows(100, "v") }));
    await createPostgresSearchIndex({ sql: off.sql, exactSetMaxChunks: 0 }).search({
      text: "",
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
    await createPostgresSearchIndex({ sql: byDefault.sql }).search({ text: "", companyId, datasetId, embedding: embedding() });
    const defaultTexts = byDefault.calls.map((call) => call.text);
    expect(defaultTexts.indexOf("set local hnsw.max_scan_tuples = 100000")).toBe(
      defaultTexts.indexOf("set local hnsw.iterative_scan = relaxed_order") + 1,
    );

    const withLimit = createScriptedSql(scripted({ size: 50_000, index: manyChunkRows(100, "v") }));
    await createPostgresSearchIndex({ sql: withLimit.sql, maxScanTuples: 60_000 }).search({
      text: "",
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
      const hits = await createPostgresSearchIndex({ sql }).search({ text: "", companyId, datasetId, embedding: embedding() });

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
      .search({ text: "", companyId, datasetId, embedding: embedding() })
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
    expect(textCall?.text).toContain("to_tsquery($4::regconfig, $6)");
    expect(textCall?.text).toContain("limit $5");
    expect(textCall?.text).not.toMatch(/ilike/);
    // Every parameter the text names is bound, and no other: a driver rejects a gap. The seventh is the
    // size of the candidate pool.
    expect(textCall?.values).toEqual([longText, companyId, [datasetId], "english", 100, "light | charcoal | grill", 1000]);
    const named = new Set([...(textCall?.text.matchAll(/\$(\d+)/g) ?? [])].map((match) => Number(match[1])));
    expect([...named].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
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

// The full-text ranking has a cost bound: its own transaction with `set local statement_timeout`, a
// cancel that leaves the vector ranking to answer, and a candidate pool for the tie-break.
interface TransactionCall extends RecordedCall {
  /** Number of the transaction the statement ran in; `0` is a statement outside any transaction. */
  readonly transaction: number;
}

/**
 * Executor that numbers its transactions, so a test can tell which statement ran in which one, and that
 * counts how many transactions were open at the same moment.
 */
function createTransactionalSql(respond: (call: RecordedCall) => unknown[]): {
  sql: SqlExecutor;
  calls: TransactionCall[];
  stats: { opened: number; maxOpen: number };
} {
  const calls: TransactionCall[] = [];
  const stats = { opened: 0, maxOpen: 0 };
  let open = 0;
  const over = (transaction: number): SqlExecutor => ({
    query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      calls.push({ transaction, text, values });
      return respond({ text, values }) as Row[];
    },
    withTransaction: async (run) => {
      stats.opened += 1;
      const id = stats.opened;
      open += 1;
      stats.maxOpen = Math.max(stats.maxOpen, open);
      try {
        return await run(over(id));
      } finally {
        open -= 1;
      }
    },
  });
  return { sql: over(0), calls, stats };
}

/** Answers like a database with pgvector 0.8 and a large dataset; the rows are those of each ranking. */
function databaseAnswers(rows: { vector?: ChunkRow[]; fullText?: ChunkRow[] }): (call: RecordedCall) => unknown[] {
  return (call) => {
    if (/pg_extension/.test(call.text)) return [{ extversion: "0.8.7" }];
    if (/count\(\*\)::int as chunks/.test(call.text)) return [{ chunks: 50_000 }];
    if (/ts_rank/.test(call.text)) return rows.fullText ?? [];
    if (/<=>/.test(call.text)) return rows.vector ?? [];
    if (/select d\.id/.test(call.text)) return documents;
    return [];
  };
}

/** The same answers, except that one kind of statement fails with `error`. */
function failing(
  statement: RegExp,
  error: unknown,
  rows: { vector?: ChunkRow[]; fullText?: ChunkRow[] } = {},
): (call: RecordedCall) => unknown[] {
  const answer = databaseAnswers(rows);
  return (call) => {
    if (statement.test(call.text)) throw error;
    return answer(call);
  };
}

const longQuestion = "how do I light the charcoal in the grill";

/** What the server raises when `statement_timeout` cancels a statement. */
function statementTimeout(): Error {
  return Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
}

describe("time bound of the full-text ranking", () => {
  it("sets statement_timeout (800 ms) first in a transaction of its own, apart from the vector ranking", async () => {
    // A short text has the substring match, a long question has not; both rankings are bounded.
    for (const text of ["supply agreement", longQuestion]) {
      const { sql, calls } = createTransactionalSql(databaseAnswers({ vector: [chunkRow("a", 0, 0.9)], fullText: [chunkRow("a", 0, 0.4)] }));
      await createPostgresSearchIndex({ sql }).search({ companyId, datasetId, text, embedding: embedding() });

      const fullTextTransaction = calls.find((call) => /ts_rank/.test(call.text))?.transaction;
      const vectorTransaction = calls.find((call) => /<=>/.test(call.text))?.transaction;
      expect(fullTextTransaction).toBeGreaterThan(0);
      expect(vectorTransaction).toBeGreaterThan(0);
      expect(fullTextTransaction).not.toBe(vectorTransaction);

      const fullTextStatements = calls.filter((call) => call.transaction === fullTextTransaction).map((call) => call.text);
      expect(fullTextStatements).toHaveLength(2);
      expect(fullTextStatements[0]).toBe("set local statement_timeout = 800");
      expect(fullTextStatements[1]).toMatch(/ts_rank/);
      // The bound belongs to the full-text transaction only, and the HNSW settings to the vector one.
      const vectorStatements = calls.filter((call) => call.transaction === vectorTransaction).map((call) => call.text);
      expect(vectorStatements.some((statement) => /statement_timeout/.test(statement))).toBe(false);
      expect(fullTextStatements.some((statement) => /hnsw/.test(statement))).toBe(false);
      expect(vectorStatements[0]).toBe("set local hnsw.ef_search = 64");
    }
  });

  it("sets the bound of the option, and 0 sets none of its own", async () => {
    const custom = createTransactionalSql(databaseAnswers({ fullText: [chunkRow("a", 0, 0.4)] }));
    await createPostgresSearchIndex({ sql: custom.sql, fullTextTimeoutMs: 250 }).search({ companyId, datasetId, text: longQuestion });
    expect(custom.calls.map((call) => call.text)[0]).toBe("set local statement_timeout = 250");

    const off = createTransactionalSql(databaseAnswers({ fullText: [chunkRow("a", 0, 0.4)] }));
    await createPostgresSearchIndex({ sql: off.sql, fullTextTimeoutMs: 0 }).search({ companyId, datasetId, text: longQuestion });
    expect(off.calls.some((call) => /statement_timeout/.test(call.text))).toBe(false);
    expect(off.calls.some((call) => /ts_rank/.test(call.text))).toBe(true);
  });

  it("refuses a bound or a pool that is not a whole number in range", () => {
    const { sql } = createTransactionalSql(databaseAnswers({}));
    for (const fullTextTimeoutMs of [-1, 1.5, Number.NaN, 2_147_483_648]) {
      expect(() => createPostgresSearchIndex({ sql, fullTextTimeoutMs })).toThrow(RangeError);
    }
    expect(() => createPostgresSearchIndex({ sql, fullTextTimeoutMs: 2_147_483_647 })).not.toThrow();
    for (const fullTextRerankPool of [-1, 1.5, Number.NaN]) {
      expect(() => createPostgresSearchIndex({ sql, fullTextRerankPool })).toThrow(RangeError);
    }
  });

  it("answers from the vector ranking when the server cancels the full-text ranking, and says so", async () => {
    for (const [text, substringMatch] of [
      [longQuestion, false],
      ["supply agreement", true],
    ] as const) {
      const events: FullTextTimeoutEvent[] = [];
      const { sql } = createTransactionalSql(
        failing(/ts_rank/, statementTimeout(), { vector: [chunkRow("a", 0, 0.9), chunkRow("b", 1, 0.8, secondDocumentId)] }),
      );
      const hits = await createPostgresSearchIndex({ sql, onFullTextTimeout: (event) => events.push(event) }).search({
        companyId,
        datasetId,
        text,
        embedding: embedding(),
        limit: 2,
      });

      expect(hits.map((hit) => hit.chunkId)).toEqual(["a", "b"]);
      expect(hits[0].fusion).toEqual({ vectorRank: 1, fullTextRank: null });
      expect(events).toEqual([
        { companyId, datasetIds: [datasetId], textLength: text.length, substringMatch, timeoutMs: 800, elapsedMs: expect.any(Number) },
      ]);
    }
  });

  it("finds the cancel behind a wrapper that keeps the driver error as its cause", async () => {
    // The query layer of the product wraps driver errors; the SQLSTATE is on the `cause`.
    const wrapped = Object.assign(new Error("Failed query: select ... params: ..."), { cause: statementTimeout() });
    const { sql } = createTransactionalSql(failing(/ts_rank/, wrapped, { vector: [chunkRow("a", 0, 0.9)] }));
    const hits = await createPostgresSearchIndex({ sql }).search({ companyId, datasetId, text: longQuestion, embedding: embedding() });
    expect(hits.map((hit) => hit.chunkId)).toEqual(["a"]);

    // A wrapper around another driver error is still that error.
    const deadlock = Object.assign(new Error("Failed query: select ... params: ..."), {
      cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    });
    const other = createTransactionalSql(failing(/ts_rank/, deadlock, { vector: [chunkRow("a", 0, 0.9)] }));
    await expect(
      createPostgresSearchIndex({ sql: other.sql }).search({ companyId, datasetId, text: longQuestion, embedding: embedding() }),
    ).rejects.toBe(deadlock);
  });

  it("does not swallow any other error of the full-text ranking", async () => {
    for (const error of [
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      Object.assign(new Error("syntax error at or near"), { code: "42601" }),
      new Error("connection terminated"),
      "57014",
      null,
    ]) {
      const { sql } = createTransactionalSql(failing(/ts_rank/, error, { vector: [chunkRow("a", 0, 0.9)], }));
      const events: FullTextTimeoutEvent[] = [];
      const outcome = await createPostgresSearchIndex({ sql, onFullTextTimeout: (event) => events.push(event) })
        .search({ companyId, datasetId, text: longQuestion, embedding: embedding() })
        .then(() => ({ rejected: false as const }), (thrown: unknown) => ({ rejected: true as const, thrown }));
      expect(outcome).toEqual({ rejected: true, thrown: error });
      expect(events).toHaveLength(0);
    }
  });

  it("does not swallow the cancel of the vector ranking", async () => {
    const cancel = statementTimeout();
    const { sql } = createTransactionalSql(failing(/<=>/, cancel, { fullText: [chunkRow("a", 0, 0.4)] }));
    const error = await createPostgresSearchIndex({ sql })
      .search({ companyId, datasetId, text: longQuestion, embedding: embedding() })
      .then(() => null, (thrown: unknown) => thrown);
    expect(error).toBe(cancel);
  });

  it("throws the cancel of a search that has no vector ranking, instead of an empty list", async () => {
    const cancel = statementTimeout();
    const { sql } = createTransactionalSql(failing(/ts_rank/, cancel));
    const events: FullTextTimeoutEvent[] = [];
    const error = await createPostgresSearchIndex({ sql, onFullTextTimeout: (event) => events.push(event) })
      .search({ companyId, datasetId, text: longQuestion })
      .then(() => null, (thrown: unknown) => thrown);
    expect(error).toBe(cancel);
    expect(events).toHaveLength(0);
  });

  it("is not failed by a diagnostic that throws, and needs none", async () => {
    const rows = { vector: [chunkRow("a", 0, 0.9)] };
    const broken = createTransactionalSql(failing(/ts_rank/, statementTimeout(), rows));
    const withBrokenCallback = await createPostgresSearchIndex({
      sql: broken.sql,
      onFullTextTimeout: () => {
        throw new Error("logger is down");
      },
    }).search({ companyId, datasetId, text: longQuestion, embedding: embedding() });
    expect(withBrokenCallback.map((hit) => hit.chunkId)).toEqual(["a"]);

    const bare = createTransactionalSql(failing(/ts_rank/, statementTimeout(), rows));
    const withoutCallback = await createPostgresSearchIndex({ sql: bare.sql }).search({
      companyId,
      datasetId,
      text: longQuestion,
      embedding: embedding(),
    });
    expect(withoutCallback.map((hit) => hit.chunkId)).toEqual(["a"]);
  });

  it("runs the two rankings side by side, each in its own transaction", async () => {
    const both = createTransactionalSql(databaseAnswers({ vector: [chunkRow("a", 0, 0.9)], fullText: [chunkRow("a", 0, 0.4)] }));
    await createPostgresSearchIndex({ sql: both.sql }).search({ companyId, datasetId, text: longQuestion, embedding: embedding() });
    expect(both.stats).toEqual({ opened: 2, maxOpen: 2 });

    // One ranking alone is one transaction.
    const vectorOnly = createTransactionalSql(databaseAnswers({ vector: [chunkRow("a", 0, 0.9)] }));
    await createPostgresSearchIndex({ sql: vectorOnly.sql }).search({ companyId, datasetId, text: "", embedding: embedding() });
    expect(vectorOnly.stats).toEqual({ opened: 1, maxOpen: 1 });
    const textOnly = createTransactionalSql(databaseAnswers({ fullText: [chunkRow("a", 0, 0.4)] }));
    await createPostgresSearchIndex({ sql: textOnly.sql }).search({ companyId, datasetId, text: longQuestion });
    expect(textOnly.stats).toEqual({ opened: 1, maxOpen: 1 });
  });

  it("reports the error of the vector ranking first when both rankings fail", async () => {
    const answer = databaseAnswers({});
    const { sql } = createTransactionalSql((call) => {
      if (/ts_rank/.test(call.text)) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      if (/set local hnsw\.ef_search/i.test(call.text)) throw Object.assign(new Error("column does not exist"), { code: "42703" });
      return answer(call);
    });
    const error = await createPostgresSearchIndex({ sql })
      .search({ companyId, datasetId, text: longQuestion, embedding: embedding() })
      .then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CorpusVectorSearchUnavailableError);
  });
});

describe("candidate pool of the full-text ranking", () => {
  const rankingCall = async (
    options: { fullTextRerankPool?: number; fusion?: { k0: number; kCandidates: number }; schema?: typeof DEFAULT_SEARCH_INDEX_SCHEMA } = {},
    text = longQuestion,
  ): Promise<TransactionCall> => {
    const { sql, calls } = createTransactionalSql(databaseAnswers({ fullText: [chunkRow("t", 0, 0.3)] }));
    await createPostgresSearchIndex({ sql, ...options }).search({ companyId, datasetId, text });
    const call = calls.find((candidate) => /ts_rank/.test(candidate.text));
    if (call === undefined) throw new Error("the full-text ranking did not run");
    return call;
  };

  it("computes similarity only over the pool: ts_rank and the pool in the inner statement, similarity in the outer", async () => {
    const call = await rankingCall();
    const parts = call.text.split(/\n\s*\) r\n/);
    expect(parts).toHaveLength(2);
    const [inner, outer] = parts;

    expect(inner).toContain("ts_rank(");
    expect(inner).toContain("order by score desc");
    expect(inner).toContain("limit $7");
    expect(inner).toContain("@@");
    expect(inner).not.toContain("similarity");
    expect(outer).toContain('similarity(r.content, $1) desc');
    expect(outer).toContain("order by r.score desc");
    expect(outer).toContain("limit $5");
    expect(outer).not.toContain("ts_rank");
    // The outer statement hands back the columns the module reads, under the names it reads them by.
    for (const column of ["id", "company_id", "document_id", "chunk_index", "content", "token_count", "metadata", "score"]) {
      expect(inner.split("from (")[0]).toContain(`r.${column}`);
    }
    // No substring match, the tsvector alone.
    expect(call.text).not.toMatch(/ilike/);
    expect(call.values).toEqual([longQuestion, companyId, [datasetId], "english", 100, "light | charcoal | grill", 1000]);
  });

  it("reads the content column of the schema under the name the outer statement uses", async () => {
    const call = await rankingCall({ schema: { ...DEFAULT_SEARCH_INDEX_SCHEMA, contentColumn: "body" } });
    expect(call.text).toContain('c."body" as content');
    expect(call.text).toContain("similarity(r.content, $1) desc");
    expect(call.text).not.toContain('similarity(c."body"');
  });

  it("honours the pool option, and never keeps fewer candidates than the fusion takes", async () => {
    expect((await rankingCall({ fullTextRerankPool: 300 })).values[6]).toBe(300);
    // Below kCandidates (100) the pool would cut the list the fusion asks for.
    expect((await rankingCall({ fullTextRerankPool: 50 })).values[6]).toBe(100);
    expect((await rankingCall({ fusion: { k0: 60, kCandidates: 2500 } })).values[6]).toBe(2500);
  });

  it("ranks over every match, as before, when the pool is 0", async () => {
    const call = await rankingCall({ fullTextRerankPool: 0 });
    expect(call.text).toContain('similarity(c."content", $1) desc');
    expect(call.text).toContain("order by ts_rank(");
    expect(call.text).toContain("limit $5");
    expect(call.text).not.toMatch(/\) r\b|\$7/);
    expect(call.values).toEqual([longQuestion, companyId, [datasetId], "english", 100, "light | charcoal | grill"]);
  });

  it("keeps the statement of short texts and identifiers, which have the substring match", async () => {
    for (const text of ["supply agreement", "litellm_proxy_config"]) {
      const call = await rankingCall({}, text);
      expect(call.text).toContain('c."content" ilike $4');
      expect(call.text).toContain('similarity(c."content", $1) desc');
      expect(call.text).toContain("limit $6");
      // No inner statement and no pool: the order and the answer are those of the statement as it was.
      expect(call.text).not.toMatch(/\) r\b|\$8/);
      expect(call.values).toHaveLength(7);
      expect(call.values[3]).toBe(`%${escapeLikePattern(text)}%`);
    }
  });
});
