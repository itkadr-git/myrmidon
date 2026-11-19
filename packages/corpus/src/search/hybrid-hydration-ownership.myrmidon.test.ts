import { describe, expect, it } from "vitest";
import { createPostgresSearchIndex, type SqlExecutor } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
const vectorDoc = "cccccccc-0000-0000-0000-000000000001";
const textDoc = "cccccccc-0000-0000-0000-000000000002";
const missingDoc = "cccccccc-0000-0000-0000-000000000003";
const wrongDoc = "cccccccc-0000-0000-0000-000000000004";

type Call = { text: string; values: readonly unknown[] };
function row(id: string, documentId: string, content: string, chunkIndex: string, tokenCount: string | null, metadata: Record<string, unknown> | null) {
  return { id, company_id: companyId, document_id: documentId, content, chunk_index: chunkIndex, token_count: tokenCount, metadata, score: 1 };
}

describe("hybrid hydration ownership", () => {
  it("keeps vector ownership and both ranks while hydrating by document id", async () => {
    const calls: Call[] = [];
    const vector = [row("shared", vectorDoc, "vector content", "7", "42", { owner: "vector" }), row("missing", missingDoc, "missing", "0", null, null), row("same-doc", vectorDoc, "duplicate document", "9", null, null)];
    const fullText = [row("shared", wrongDoc, "text conflict", "99", "999", { owner: "text" }), row("text-only", textDoc, "text content", "12", null, null)];
    const docs = [
      { id: textDoc, dataset_id: datasetId, title: "Text document", source_uri: null },
      { id: vectorDoc, dataset_id: datasetId, title: "Vector document", source_uri: "file://vector" },
    ];
    const sql: SqlExecutor = {
      query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (/pg_extension/.test(text)) return [{ extversion: "0.8.7" }] as unknown as Row[];
        if (/<=>/.test(text)) return vector as unknown as Row[];
        if (/ts_rank/.test(text)) return fullText as unknown as Row[];
        if (/select d\.id/.test(text)) return docs as unknown as Row[];
        return [];
      },
      withTransaction: (callback) => callback(sql),
    };
    const hits = await createPostgresSearchIndex({ sql }).search({
      companyId, datasetId, text: "contract", embedding: Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0), limit: 10,
    });

    expect(hits.map((hit) => hit.chunkId)).toEqual(["shared", "text-only"]);
    expect(hits[0].score).toBeCloseTo(2 / 61, 12);
    expect(hits[0].fusion).toEqual({ vectorRank: 1, fullTextRank: 1 });
    expect(hits[0]).toMatchObject({ documentId: vectorDoc, datasetId, content: "vector content", metadata: { owner: "vector" } });
    expect(hits[0].chunk).toEqual({ id: "shared", companyId, datasetId, documentId: vectorDoc, chunkIndex: 7, content: "vector content", tokenCount: 42, metadata: { owner: "vector" } });
    expect(hits[0].document).toEqual({ id: vectorDoc, datasetId, title: "Vector document", sourceUri: "file://vector" });
    expect(hits[1].fusion).toEqual({ vectorRank: null, fullTextRank: 2 });
    expect(hits[1]).toMatchObject({ documentId: textDoc, datasetId, content: "text content", metadata: {} });
    expect(hits[1].chunk).toEqual({ id: "text-only", companyId, datasetId, documentId: textDoc, chunkIndex: 12, content: "text content", tokenCount: null, metadata: {} });
    expect(hits[1].document).toEqual({ id: textDoc, datasetId, title: "Text document", sourceUri: null });
    const hydration = calls.filter((call) => /select d\.id/.test(call.text));
    expect(hydration).toHaveLength(1);
    expect(hydration[0].values).toEqual([companyId, [vectorDoc, missingDoc, textDoc]]);
    expect(hydration[0].text).toMatch(/d\.company_id\s*=\s*\$1::uuid/);
    expect(calls.filter((call) => /<=>/.test(call.text))).toHaveLength(1);
    expect(calls.filter((call) => /ts_rank/.test(call.text))).toHaveLength(1);
  });
});
