import { describe, expect, it } from "vitest";

import { createPostgresSearchIndex, type SqlExecutor } from "./hybrid-search-index.js";
import {
  PROBE_CHUNK_COLUMNS,
  PROBE_DOCUMENT_COLUMNS,
  PROBE_FTS_LANGUAGE,
  PROBE_SEARCH_INDEX_SCHEMA,
  probeContentTsVector,
  probeSchemaSql,
} from "./probe-schema.js";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./vector.js";

// The integration suite of the hybrid index only runs where PostgreSQL is installed, so a probe
// table that has drifted from the search SQL would first be noticed as a red lane in CI — a probe
// table with a stale column does not skip, it fails. These checks run everywhere instead: they take
// the SQL the index really emits (a recording executor) and assert every `c.<column>` /
// `d.<column>` reference exists in the probe schema the suite creates.

const companyId = "aaaaaaaa-0000-0000-0000-000000000001";
const datasetId = "bbbbbbbb-0000-0000-0000-000000000002";
const documentId = "cccccccc-0000-0000-0000-000000000003";
const chunkId = "dddddddd-0000-0000-0000-000000000004";

interface RecordedCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function recordingSql(): { sql: SqlExecutor; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const chunkRows = [
    {
      id: chunkId,
      company_id: companyId,
      document_id: documentId,
      chunk_index: 0,
      content: "probe chunk",
      token_count: 2,
      metadata: { pageNumber: 1 },
      score: 0.5,
    },
  ];
  const documentRows = [{ id: documentId, dataset_id: datasetId, title: "Probe", source_uri: "file://probe.pdf" }];
  const handle = async (text: string, values: readonly unknown[] = []): Promise<unknown[]> => {
    calls.push({ text, values });
    if (/set local hnsw\.ef_search/i.test(text)) return [];
    if (/ts_rank/.test(text)) return chunkRows;
    if (/<=>/.test(text)) return chunkRows;
    // The document hydration runs per matched chunk; answering it keeps the third statement visible.
    if (/select d\.id/.test(text)) return documentRows;
    return [];
  };
  const executor: SqlExecutor = {
    query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      (await handle(text, values)) as Row[],
    withTransaction: (callback) => callback(executor),
  };
  return { sql: executor, calls };
}

/** Runs one hybrid query and returns the SQL the index emitted plus its bound values. */
async function emittedStatements(): Promise<RecordedCall[]> {
  const { sql, calls } = recordingSql();
  const index = createPostgresSearchIndex({
    sql,
    schema: PROBE_SEARCH_INDEX_SCHEMA,
    ftsLanguage: PROBE_FTS_LANGUAGE,
  });
  const embedding = Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, position) => (position === 0 ? 1 : 0));
  await index.search({ companyId, datasetId, text: "probe", embedding, limit: 5 });
  return calls;
}

function columnReferences(calls: readonly RecordedCall[]): { chunks: Set<string>; documents: Set<string> } {
  const chunks = new Set<string>();
  const documents = new Set<string>();
  const pattern = /\b([cd])\.([a-z_][a-z0-9_]*)/g;
  for (const call of calls) {
    for (const match of call.text.matchAll(pattern)) {
      if (match[1] === "c") chunks.add(match[2]);
      else documents.add(match[2]);
    }
  }
  return { chunks, documents };
}

describe("probe schema of the hybrid search integration suite", () => {
  it("reads only chunk columns the probe table creates", async () => {
    const { chunks } = columnReferences(await emittedStatements());
    expect(chunks.size).toBeGreaterThan(3);
    const missing = [...chunks].filter((column) => !(PROBE_CHUNK_COLUMNS as readonly string[]).includes(column));
    expect(missing).toEqual([]);
  });

  it("reads only document columns the probe table creates", async () => {
    const { documents } = columnReferences(await emittedStatements());
    expect(documents.size).toBeGreaterThan(3);
    const missing = [...documents].filter((column) => !(PROBE_DOCUMENT_COLUMNS as readonly string[]).includes(column));
    expect(missing).toEqual([]);
  });

  it("declares the columns the index is configured with", () => {
    const columns = PROBE_CHUNK_COLUMNS as readonly string[];
    expect(columns).toContain(PROBE_SEARCH_INDEX_SCHEMA.contentColumn);
    expect(columns).toContain(PROBE_SEARCH_INDEX_SCHEMA.fullTextColumn);
    expect(columns).toContain(PROBE_SEARCH_INDEX_SCHEMA.embeddingColumn);
    expect(PROBE_DOCUMENT_COLUMNS as readonly string[]).toContain("status");
  });

  it("creates every declared column, with the full text column as a tsvector", () => {
    const ddl = probeSchemaSql();
    for (const column of [...PROBE_CHUNK_COLUMNS, ...PROBE_DOCUMENT_COLUMNS]) {
      expect(new RegExp(`\\b${column}\\s+\\S`).test(ddl)).toBe(true);
    }
    expect(ddl).toMatch(new RegExp(`${PROBE_SEARCH_INDEX_SCHEMA.fullTextColumn}\\s+tsvector`));
    expect(ddl).toContain(`gin (${PROBE_SEARCH_INDEX_SCHEMA.fullTextColumn})`);
    expect(ddl).toContain(`vector(${CORPUS_EMBEDDING_DIMENSIONS})`);
  });

  it("seeds the text with the same language the query uses", async () => {
    const statements = await emittedStatements();
    const fullText = statements.find((call) => /ts_rank/.test(call.text));
    expect(fullText).toBeDefined();
    expect(fullText?.text).toContain("::regconfig");
    expect(fullText?.values).toContain(PROBE_FTS_LANGUAGE);
    expect(probeContentTsVector("$1")).toContain(`'${PROBE_FTS_LANGUAGE}'`);
  });
});