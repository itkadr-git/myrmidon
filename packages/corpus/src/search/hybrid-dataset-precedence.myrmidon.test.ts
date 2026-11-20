import { describe, expect, it } from "vitest";
import { createPostgresSearchIndex, type SqlExecutor } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

const company = "aaaaaaaa-0000-0000-0000-000000000001";
const otherCompany = "aaaaaaaa-0000-0000-0000-000000000002";
const a = "bbbbbbbb-0000-0000-0000-000000000001";
const b = "bbbbbbbb-0000-0000-0000-000000000002";
const c = "bbbbbbbb-0000-0000-0000-000000000003";
const doc = "cccccccc-0000-0000-0000-000000000001";
const embedding = Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);

type Call = { text: string; values: readonly unknown[] };
const isProbe = (call: Call) => /count\(\*\)::int as chunks/.test(call.text);
const isVector = (call: Call) => /<=>/.test(call.text);
const isText = (call: Call) => /ts_rank/.test(call.text);
const isHydration = (call: Call) => /select d\.id, d\.dataset_id/.test(call.text);

function recordingSql(size: number) {
  const calls: Call[] = [];
  const sql: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<Row[]> {
      calls.push({ text, values });
      let rows: Record<string, unknown>[] = [];
      if (/pg_extension/.test(text)) rows = [{ extversion: "0.8.7" }];
      else if (isProbe({ text, values })) rows = [{ chunks: size }];
      else if (isVector({ text, values }) || isText({ text, values })) {
        rows = [{ id: "chunk", company_id: values[1], document_id: doc, chunk_index: 0, content: "chunk", token_count: 1, metadata: {}, score: 1 }];
      } else if (isHydration({ text, values })) {
        rows = [{ id: doc, dataset_id: a, title: "title", source_uri: null }];
      }
      return rows as Row[];
    },
    withTransaction: (run) => run(sql),
  };
  return { sql, calls };
}

function one(calls: Call[], predicate: (call: Call) => boolean): Call {
  const matched = calls.filter(predicate);
  expect(matched).toHaveLength(1);
  return matched[0];
}

function assertScope(call: Call, companyParam: number, datasetParam: number) {
  expect(call.text).toContain('join "corpus_documents" d on d.id = c.document_id and d.company_id = c.company_id');
  expect(call.text).toContain(`c.company_id = $${companyParam}::uuid`);
  expect(call.text).toContain(`($${datasetParam}::uuid[] is null or d.dataset_id = any($${datasetParam}::uuid[]))`);
  expect(call.text).toContain("d.status = 'ready'");
}

describe("dataset scope precedence", () => {
  const variants = [
    { name: "undefined", datasets: undefined, expected: [c] },
    { name: "empty", datasets: [], expected: [] },
    { name: "one", datasets: [a], expected: [a] },
    { name: "multiple", datasets: [a, b], expected: [a, b] },
  ];
  const textBranches = [
    { name: "ILIKE", text: "contract", pool: 1000 },
    { name: "bounded", text: "a longer question about a contract", pool: 1000 },
    { name: "unbounded", text: "a longer question about a contract", pool: 0 },
  ];
  for (const size of [10, 10001]) {
    for (const branch of textBranches) {
      for (const variant of variants) {
        it(`${size === 10 ? "exact" : "iterative"} / ${branch.name} preserves ${variant.name} scope`, async () => {
          const { sql, calls } = recordingSql(size);
          const index = createPostgresSearchIndex({ sql, exactSetMaxChunks: 10000, fullTextRerankPool: branch.pool });
          const hits = await index.search({ companyId: company, datasetId: c, datasetIds: variant.datasets, text: branch.text, embedding });
          const probe = one(calls, isProbe);
          const vector = one(calls, isVector);
          const text = one(calls, isText);
          const hydration = one(calls, isHydration);
          expect(probe.values).toEqual([company, variant.expected, 10001]);
          expect(vector.values).toEqual([expect.any(String), company, variant.expected, 100]);
          expect(text.values.slice(0, 3)).toEqual([branch.text, company, variant.expected]);
          expect(probe.values[1]).toBe(vector.values[2]);
          expect(text.values[2]).toBe(vector.values[2]);
          if (variant.datasets !== undefined) expect(vector.values[2]).toBe(variant.datasets);
          assertScope(probe, 1, 2);
          assertScope(vector, 2, 3);
          assertScope(text, 2, 3);
          expect(vector.text.includes('+ 0')).toBe(size === 10);
          expect(text.text.includes(' ilike ')).toBe(branch.name === "ILIKE");
          expect(text.text.includes('limit $7')).toBe(branch.name === "bounded");
          expect(hydration.text).toContain('where d.company_id = $1::uuid');
          expect(hydration.values).toEqual([company, [doc]]);
          expect(hits).toHaveLength(1);
          expect(hits[0]).toMatchObject({ chunkId: "chunk", documentId: doc, fusion: { vectorRank: 1, fullTextRank: 1 } });
        });
      }
    }
  }

  it("does not retain scope across searches on the same index", async () => {
    const { sql, calls } = recordingSql(10);
    const index = createPostgresSearchIndex({ sql });
    const first = [a, b];
    const second = [c];
    await index.search({ companyId: company, datasetIds: first, text: "contract", embedding });
    const split = calls.length;
    await index.search({ companyId: otherCompany, datasetIds: second, text: "contract", embedding });
    for (const [batch, expectedCompany, expectedScope] of [
      [calls.slice(0, split), company, first],
      [calls.slice(split), otherCompany, second],
    ] as const) {
      const probe = one(batch, isProbe);
      const vector = one(batch, isVector);
      const text = one(batch, isText);
      const hydration = one(batch, isHydration);
      expect(probe.values.slice(0, 2)).toEqual([expectedCompany, expectedScope]);
      expect(vector.values.slice(1, 3)).toEqual([expectedCompany, expectedScope]);
      expect(text.values.slice(1, 3)).toEqual([expectedCompany, expectedScope]);
      expect(probe.values[1]).toBe(expectedScope);
      expect(vector.values[2]).toBe(expectedScope);
      expect(text.values[2]).toBe(expectedScope);
      expect(hydration.values).toEqual([expectedCompany, [doc]]);
    }
    expect(calls.filter((call) => /pg_extension/.test(call.text))).toHaveLength(1);
  });
});
