import { describe, expect, it } from "vitest";
import { createPostgresSearchIndex, type SearchIndexSchema, type SqlExecutor } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

const schema: SearchIndexSchema = {
  chunksTable: "_chunks2",
  documentsTable: "documents3",
  contentColumn: "body4",
  fullTextColumn: "_fts5",
  embeddingColumn: "vec6",
};
const companyId = "company-id";
const datasetId = "dataset-id";
const documentId = "document-id";
const row = { id: "chunk-id", company_id: companyId, document_id: documentId, chunk_index: 0, content: "result", token_count: 3, metadata: { page: 1 }, score: 0.8 };
const document = { id: documentId, dataset_id: datasetId, title: "Title", source_uri: "uri" };

type Call = { text: string; values: readonly unknown[] };
function recordingSql(size = 1) {
  const calls: Call[] = [];
  let transactions = 0;
  const sql: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<Row[]> {
      calls.push({ text, values });
      let rows: Record<string, unknown>[] = [];
      if (text.includes("pg_extension")) rows = [{ extversion: "0.8.7" }];
      else if (text.includes("count(*)::int as chunks")) rows = [{ chunks: size }];
      else if (text.includes("<=>") || text.includes("ts_rank")) rows = [row];
      else if (text.includes("select d.id")) rows = [document];
      return rows as Row[];
    },
    withTransaction(callback) { transactions += 1; return callback(sql); },
  };
  return { sql, calls, transactionCount: () => transactions };
}

const invalid = ["bad name", "Uppercase", "public.name", 'bad"name', "bad;name", "bad-name", "1name", ""];
const fields: (keyof SearchIndexSchema)[] = ["chunksTable", "documentsTable", "contentColumn", "fullTextColumn", "embeddingColumn"];

describe("schema identifier gates", () => {
  it.each(fields.flatMap((field) => invalid.map((value) => ({ field, value }))))(
    "rejects $field = $value before any database operation", ({ field, value }) => {
      const db = recordingSql();
      expect(() => createPostgresSearchIndex({ sql: db.sql, schema: { ...schema, [field]: value } })).toThrow(RangeError);
      expect(db.calls).toHaveLength(0);
      expect(db.transactionCount()).toBe(0);
    },
  );

  it.each(invalid)("rejects full text language %s independently", (ftsLanguage) => {
    const db = recordingSql();
    expect(() => createPostgresSearchIndex({ sql: db.sql, schema, ftsLanguage })).toThrow(RangeError);
    expect(db.calls).toHaveLength(0);
    expect(db.transactionCount()).toBe(0);
  });

  it.each([
    { name: "substring and exact vector", text: "alpha'; %_", size: 1, pool: 200, exact: true, substring: true },
    { name: "bounded full text and index vector", text: "alpha beta", size: 50000, pool: 200, exact: false, substring: false },
    { name: "unbounded full text and index vector", text: "alpha beta", size: 50000, pool: 0, exact: false, substring: false },
  ])("uses valid identifiers in $name and hydrates results", async ({ text, size, pool, exact, substring }) => {
    const db = recordingSql(size);
    const vector = Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);
    const hits = await createPostgresSearchIndex({ sql: db.sql, schema, ftsLanguage: "_english2", ilikeMaxLength: substring ? 100 : 1, fullTextRerankPool: pool }).search({ companyId, datasetId, text, embedding: vector });
    expect(db.transactionCount()).toBe(2);
    const ranking = db.calls.filter((call) => call.text.includes("<=>"));
    const fts = db.calls.filter((call) => call.text.includes("ts_rank"));
    const sizing = db.calls.filter((call) => call.text.includes("count(*)::int as chunks"));
    const hydration = db.calls.filter((call) => call.text.includes("select d.id"));
    expect(ranking).toHaveLength(1); expect(fts).toHaveLength(1); expect(sizing).toHaveLength(1); expect(hydration).toHaveLength(1);
    for (const call of [ranking[0], fts[0], sizing[0]]) {
      expect(call.text).toContain('from "_chunks2" c');
      expect(call.text).toContain('join "documents3" d');
    }
    expect(ranking[0].text).toContain('c."body4" as content');
    expect(ranking[0].text).toContain('c."vec6" <=> $1::vector');
    expect(ranking[0].text.includes("+ 0")).toBe(exact);
    expect(sizing[0].text).toContain('c."vec6" is not null');
    expect(fts[0].text).toContain('c."_fts5"');
    expect(fts[0].text).toContain('c."body4" as content');
    expect(fts[0].text.includes('c."body4" ilike $4')).toBe(substring);
    expect(fts[0].text.includes("limit $7")).toBe(!substring && pool > 0);
    expect(fts[0].text).not.toContain(text);
    expect(fts[0].text).not.toContain("_english2");
    expect(fts[0].text).toContain(substring ? "plainto_tsquery($5::regconfig, $1)" : "plainto_tsquery($4::regconfig, $1)");
    expect(fts[0].values[0]).toBe(text);
    expect(fts[0].values[substring ? 4 : 3]).toBe("_english2");
    expect(ranking[0].values).toEqual([`[${vector.join(",")}]`, companyId, [datasetId], 100]);
    expect(sizing[0].values).toEqual([companyId, [datasetId], 10001]);
    expect(hydration[0].text).toContain('from "documents3" d');
    expect(hydration[0].values).toEqual([companyId, [documentId]]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ chunkId: row.id, documentId, datasetId, content: row.content, chunk: { content: row.content, metadata: row.metadata }, document: { id: documentId, title: "Title", sourceUri: "uri" }, fusion: { vectorRank: 1, fullTextRank: 1 } });
  });
});
