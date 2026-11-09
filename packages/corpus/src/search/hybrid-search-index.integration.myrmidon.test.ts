import postgres from "postgres";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installPgvectorIntoEmbeddedCluster } from "../test-pgvector.js";
import { createPostgresSearchIndex, pgvectorHasIterativeScan, type SqlExecutor } from "./hybrid-search-index.js";
import {
  PROBE_FTS_LANGUAGE,
  PROBE_SEARCH_INDEX_SCHEMA,
  probeContentTsVector,
  probeSchemaSql,
} from "./probe-schema.js";
import { CORPUS_EMBEDDING_DIMENSIONS, l2Normalize, toPgVectorLiteral } from "./vector.js";

// Hybrid search needs PostgreSQL with the `vector` and `pg_trgm` extensions. The suite looks for a
// database to run against in two steps and skips itself loudly, with the reason, when neither is
// available:
//
//   1. `CORPUS_TEST_PGVECTOR_DSN` — an external stand that allows `CREATE EXTENSION`.
//   2. the embedded PostgreSQL 18 cluster of `@myrmidon/db`, with pgvector staged into it by the
//      package's own shim (`installPgvectorIntoEmbeddedCluster`) — the same pair the store/queue
//      suite uses. The shim caches the Debian pgvector package and reports why it cannot stage the
//      extension (foreign host, no network, no `ar`/`tar`), and the suite skips on that reason.
//
// Everything the suite needs is created and dropped in its own probe tables, so a shared stand
// keeps its own data. `CORPUS_SEARCH_PERF_CHUNKS` scales the synthetic corpus up to the acceptance
// size (10^5) for the latency measurement:
//
//   CORPUS_TEST_PGVECTOR_DSN=postgres://… pnpm --filter @myrmidon/corpus exec vitest run

const DSN_ENV = "CORPUS_TEST_PGVECTOR_DSN";
// Text search configuration of the probe column and of the query; both come from the probe schema
// module, where `probe-schema.test.ts` asserts them against the real search SQL.
const FTS_LANGUAGE = PROBE_FTS_LANGUAGE;
const PERFORMANCE_BUDGET_MS = 2_000;
const DEFAULT_STAND_CHUNKS = 2_000;
const perfChunks = Number.parseInt(process.env.CORPUS_SEARCH_PERF_CHUNKS ?? "", 10);
const standChunks = Number.isInteger(perfChunks) && perfChunks > 0 ? perfChunks : DEFAULT_STAND_CHUNKS;

const INSERT_BATCH = 200;
const COMPANY_ID = "aaaaaaaa-0000-0000-0000-0000000000c1";
const DATASET_ID = "bbbbbbbb-0000-0000-0000-0000000000d1";
// A query whose words appear in no chunk, so the full-text leg returns nothing and the fused list is
// the vector ranking alone. The recall figures are read off that ranking: asking with wording every
// chunk shares would measure the dilution of the fusion instead of the reach of the vector leg.
const NO_MATCH_TEXT = "zzzqqq nonexistent wording";
const OTHER_DATASET_ID = "bbbbbbbb-0000-0000-0000-0000000000d2";
const FOREIGN_CHUNK_ID = "eeeeeeee-0000-0000-0000-000000000001";
// A dataset of the same company that holds a few dozen chunks: the HNSW scan, cut by company only,
// has to walk far to find them, so the exact ranking over its own chunks is the way to rank it.
const SMALL_DATASET_ID = "bbbbbbbb-0000-0000-0000-0000000000d3";
const SMALL_DATASET_CHUNKS = 30;
const SMALL_INDEX_BASE = 3_000_000;
// The product reads a dataset of up to 10 000 chunks exactly. The stand's main dataset (2 000 chunks, or
// 10^5 with CORPUS_SEARCH_PERF_CHUNKS) has to go through the HNSW index like a production dataset, so
// the suite lowers the threshold between that dataset and the 30-chunk one.
const STAND_EXACT_SET_MAX_CHUNKS = 500;

const schema = PROBE_SEARCH_INDEX_SCHEMA;

const DSN = process.env[DSN_ENV]?.trim();

/** Host and database only: a stand URL must never reach the log with its credentials. */
function standTarget(connection: string): string {
  try {
    const url = new URL(connection);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "the stand named by " + DSN_ENV;
  }
}

/** A database the suite can run against, plus the way to give it back. */
type SearchStand = {
  readonly dsn: string;
  /** Safe to log: no credentials, no host secrets. */
  readonly label: string;
  release(): Promise<void>;
};

/** Why the suite has no database, when it has none; printed once and kept for the skip line. */
let skipReason: string | undefined;

/**
 * External stand first (`CORPUS_TEST_PGVECTOR_DSN`), then the embedded cluster with pgvector staged
 * into it by the package shim. Returns `null` when neither is usable, and every failure path stays
 * a skip rather than an error: the neighbouring suites gate on the very same shim, so a host that
 * cannot stage pgvector must not turn the package red.
 */
async function resolveSearchStand(): Promise<SearchStand | null> {
  if (DSN !== undefined && DSN !== "") {
    return {
      dsn: DSN,
      label: `the external stand at ${standTarget(DSN)}`,
      release: async () => {},
    };
  }

  try {
    const embedded = await import("@myrmidon/db");
    const support = await embedded.getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      skipReason = support.reason ?? "the embedded PostgreSQL test cluster is not supported here";
      return null;
    }

    const staged = await installPgvectorIntoEmbeddedCluster();
    if (!staged.ok) {
      skipReason = `pgvector could not be staged into the embedded cluster: ${staged.reason}`;
      return null;
    }

    try {
      const database = await embedded.startEmbeddedPostgresTestDatabase("corpus-search-test-");
      return {
        dsn: database.connectionString,
        label: "the embedded PostgreSQL 18 test cluster",
        release: async () => {
          try {
            await database.cleanup();
          } finally {
            await staged.cleanup();
          }
        },
      };
    } catch (error) {
      await staged.cleanup().catch(() => {});
      throw error;
    }
  } catch (error) {
    skipReason = `the embedded PostgreSQL test cluster could not be started: ${String(error)}`;
    return null;
  }
}

const stand = await resolveSearchStand();

if (stand === null) {
  console.warn(
    `[corpus] hybrid search integration suite SKIPPED: ${skipReason ?? `${DSN_ENV} names no stand`}. ` +
      `The unit suite still covers the SQL and the fusion.`,
  );
} else {
  console.log(`[corpus] hybrid search integration suite runs against ${stand.label}`);
}

afterAll(async () => {
  if (stand) {
    await stand.release().catch(() => {});
  }
});

type PgClient = ReturnType<typeof postgres>;

interface StandChunk {
  readonly id: string;
  readonly vector: number[];
  readonly content: string;
}

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function randomVector(random: () => number): number[] {
  return l2Normalize(Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, () => random() * 2 - 1));
}

function chunkId(index: number): string {
  return `cccccccc-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

function documentId(index: number): string {
  return `dddddddd-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

function chunkContent(index: number): string {
  const marker = index % 100 === 0 ? ` unique marker number ${index / 100}` : "";
  return `Document number ${index}. Corpus text for the hybrid search check.${marker}`;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[position];
}

/**
 * Rows the planner discarded in a join. A stand whose indexes mirror the migration joins by index
 * and reports nothing here. The shape to catch is the one CI produced before that mirror was fixed:
 * a nested loop that scanned every chunk per document and removed four million pairs
 * (`Rows Removed by Join Filter: 4000000`, 789 ms over a 2000-chunk stand) — a plan production,
 * which has the indexes, would never pick, and a timing that described the stand, not the product.
 */
function joinFilterEliminations(plan: string): number {
  const match = /Rows Removed by Join Filter: (\d+)/.exec(plan);
  return match === null ? 0 : Number(match[1]);
}

/** `SqlExecutor` over postgres.js — the same narrow interface the product wires its own client to. */
function executorFromClient(client: PgClient, onQuery?: (query: RecordedQuery) => void): SqlExecutor {
  return {
    query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      onQuery?.({ text, values });
      const rows = await client.unsafe(text, values as Parameters<PgClient["unsafe"]>[1]);
      return rows as unknown as Row[];
    },
    withTransaction: async <T>(run: (transaction: SqlExecutor) => Promise<T>): Promise<T> => {
      const result: unknown = await client.begin(async (transaction: unknown) =>
        run(executorFromClient(transaction as PgClient, onQuery)),
      );
      return result as T;
    },
  };
}

async function seedStand(client: PgClient): Promise<StandChunk[]> {
  await client.unsafe(probeSchemaSql());

  const random = createRandom(20_260_408);
  const chunks: StandChunk[] = [];
  for (let index = 0; index < standChunks; index += 1) {
    chunks.push({ id: chunkId(index), vector: randomVector(random), content: chunkContent(index) });
  }

  for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH) {
    const batch = chunks.slice(offset, offset + INSERT_BATCH);
    const chunkValues: unknown[] = [];
    const chunkTuples: string[] = [];
    const documentValues: unknown[] = [];
    const documentTuples: string[] = [];
    batch.forEach((chunk, position) => {
      const base = position * 10;
      chunkValues.push(
        chunk.id,
        COMPANY_ID,
        DATASET_ID,
        documentId(offset + position),
        offset + position,
        chunk.content,
        chunk.content,
        toPgVectorLiteral(chunk.vector),
        Math.max(1, Math.ceil(chunk.content.length / 4)),
        JSON.stringify({ pageNumber: offset + position + 1 }),
      );
      chunkTuples.push(
        `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}::uuid, $${base + 5}::integer, $${base + 6}::text, ${probeContentTsVector(`$${base + 7}`)}, $${base + 8}::vector, $${base + 9}::integer, $${base + 10}::jsonb)`,
      );
      const documentBase = position * 6;
      documentValues.push(
        documentId(offset + position),
        COMPANY_ID,
        DATASET_ID,
        `Document ${offset + position}`,
        `file:///${offset + position}.pdf`,
        "ready",
      );
      documentTuples.push(
        `($${documentBase + 1}::uuid, $${documentBase + 2}::uuid, $${documentBase + 3}::uuid, $${documentBase + 4}::text, $${documentBase + 5}::text, $${documentBase + 6}::text)`,
      );
    });
    await client.unsafe(
      `insert into ${schema.documentsTable} (id, company_id, dataset_id, title, source_uri, status) values ${documentTuples.join(", ")}`,
      documentValues as Parameters<PgClient["unsafe"]>[1],
    );
    await client.unsafe(
      `insert into ${schema.chunksTable} (id, company_id, dataset_id, document_id, chunk_index, content, content_tsv, embedding, token_count, metadata) values ${chunkTuples.join(", ")}`,
      chunkValues as Parameters<PgClient["unsafe"]>[1],
    );
  }

  // One chunk in a second dataset, with the same text as the first one: a search filtered by
  // dataset must never return it.
  await client.unsafe(
    `insert into ${schema.documentsTable} (id, company_id, dataset_id, title, source_uri, status) values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text)`,
    [documentId(2_000_000), COMPANY_ID, OTHER_DATASET_ID, "Foreign document", "file:///other.pdf", "ready"] as Parameters<
      PgClient["unsafe"]
    >[1],
  );
  await client.unsafe(
    `insert into ${schema.chunksTable} (id, company_id, dataset_id, document_id, chunk_index, content, content_tsv, embedding, token_count, metadata) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6::text, ${probeContentTsVector("$7")}, $8::vector, $9::integer, $10::jsonb)`,
    [
      FOREIGN_CHUNK_ID,
      COMPANY_ID,
      OTHER_DATASET_ID,
      documentId(2_000_000),
      0,
      chunkContent(0),
      chunkContent(0),
      toPgVectorLiteral(chunks[0].vector),
      1,
      JSON.stringify({ pageNumber: 1 }),
    ] as Parameters<PgClient["unsafe"]>[1],
  );

  return chunks;
}

/** Chunks of the small dataset; each is its own document, so the diversification keeps every one. */
async function seedSmallDataset(client: PgClient): Promise<StandChunk[]> {
  const random = createRandom(31_415);
  const small: StandChunk[] = [];
  for (let position = 0; position < SMALL_DATASET_CHUNKS; position += 1) {
    const index = SMALL_INDEX_BASE + position;
    // The first note carries identifiers: file names and codes are what the substring match is kept for.
    const content =
      position === 0
        ? "Small dataset note 0. Settings live in litellm_proxy_config.yaml and docker-compose-override.yml, see rq002_is_camp_chef_explorer."
        : `Small dataset note ${position}.`;
    const chunk = { id: chunkId(index), vector: randomVector(random), content };
    small.push(chunk);
    await client.unsafe(
      `insert into ${schema.documentsTable} (id, company_id, dataset_id, title, source_uri, status) values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text)`,
      [documentId(index), COMPANY_ID, SMALL_DATASET_ID, `Small ${position}`, `file:///small-${position}.pdf`, "ready"] as Parameters<
        PgClient["unsafe"]
      >[1],
    );
    await client.unsafe(
      `insert into ${schema.chunksTable} (id, company_id, dataset_id, document_id, chunk_index, content, content_tsv, embedding, token_count, metadata) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6::text, ${probeContentTsVector("$7")}, $8::vector, $9::integer, $10::jsonb)`,
      [
        chunk.id,
        COMPANY_ID,
        SMALL_DATASET_ID,
        documentId(index),
        0,
        chunk.content,
        chunk.content,
        toPgVectorLiteral(chunk.vector),
        4,
        JSON.stringify({ pageNumber: 1 }),
      ] as Parameters<PgClient["unsafe"]>[1],
    );
  }
  return small;
}

/** Cosine order of the chunks for a query vector (all vectors are L2-normalized), nearest first. */
function exactOrder(candidates: readonly StandChunk[], vector: readonly number[]): string[] {
  const dot = (left: readonly number[], right: readonly number[]) => left.reduce((sum, value, at) => sum + value * right[at], 0);
  return [...candidates]
    .map((chunk) => ({ id: chunk.id, similarity: dot(chunk.vector, vector) }))
    .sort((left, right) => right.similarity - left.similarity)
    .map((entry) => entry.id);
}

/**
 * An executor that behaves as a cluster with pgvector before 0.8: the extension version it reports is
 * 0.7.4, and the iterative scan setting, which that version refuses, must never be sent.
 */
function withPgvectorBefore08(base: SqlExecutor): SqlExecutor {
  const wrap = (inner: SqlExecutor): SqlExecutor => ({
    query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      if (/pg_extension/.test(text)) return [{ extversion: "0.7.4" }] as unknown as Row[];
      if (/hnsw\.iterative_scan/.test(text)) throw new Error("pgvector 0.7 would refuse hnsw.iterative_scan");
      return inner.query<Row>(text, values);
    },
    withTransaction: (run) => inner.withTransaction((transaction) => run(wrap(transaction))),
  });
  return wrap(base);
}

const suite = describe.skipIf(stand === null);

suite("hybrid search over postgres with the vector extension", () => {
  // `describe.skipIf` above keeps this body off the no-stand path.
  const target = stand as SearchStand;
  let client: PgClient;
  let executor: SqlExecutor;
  let index: ReturnType<typeof createPostgresSearchIndex>;
  let chunks: StandChunk[];
  let smallChunks: StandChunk[];
  let recorded: RecordedQuery[];

  beforeAll(async () => {
    client = postgres(target.dsn, { max: 4 });
    await client.unsafe(`create extension if not exists vector`);
    await client.unsafe(`create extension if not exists pg_trgm`);
    chunks = await seedStand(client);
    smallChunks = await seedSmallDataset(client);
    recorded = [];
    executor = executorFromClient(client, (query) => recorded.push(query));
    index = createPostgresSearchIndex({
      sql: executor,
      schema,
      ftsLanguage: FTS_LANGUAGE,
      exactSetMaxChunks: STAND_EXACT_SET_MAX_CHUNKS,
    });
  });

  afterAll(async () => {
    await client.unsafe(`drop table if exists ${schema.chunksTable} cascade`);
    await client.unsafe(`drop table if exists ${schema.documentsTable} cascade`);
    await client.end();
    await target.release();
  });

  it("returns the top-k with score, chunk and document for a text query", async () => {
    const hits = await index.search({
      companyId: COMPANY_ID,
      datasetId: DATASET_ID,
      text: "unique marker number 3",
      embedding: chunks[7].vector,
      limit: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(5);
    for (const hit of hits) {
      expect(typeof hit.score).toBe("number");
      expect(hit.chunk.content.length).toBeGreaterThan(0);
      expect(hit.chunk.datasetId).toBe(DATASET_ID);
      expect(hit.document.id).toBe(hit.chunk.documentId);
      expect(hit.document.title).toMatch(/^Document /);
    }
    expect(hits.map((hit) => hit.chunk.id)).toContain(chunkId(300));
  });

  it("never leaves the requested dataset", async () => {
    const hits = await index.search({
      companyId: COMPANY_ID,
      datasetId: DATASET_ID,
      text: chunkContent(0),
      embedding: chunks[0].vector,
      limit: 10,
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.chunk.datasetId).toBe(DATASET_ID);
    expect(hits.map((hit) => hit.chunk.id)).not.toContain(FOREIGN_CHUNK_ID);
  });

  const isExactStatement = (query: RecordedQuery) => /<=>/.test(query.text) && /\) \+ 0/.test(query.text);
  const isIndexStatement = (query: RecordedQuery) => /<=>/.test(query.text) && !isExactStatement(query);
  const isIterativeScanSetting = (query: RecordedQuery) => /set local hnsw\.iterative_scan = relaxed_order/.test(query.text);

  it("returns the nearest chunks of a large dataset from the index with the iterative scan, without the exact ranking", async () => {
    recorded.length = 0;
    const source = chunks[411];
    const hits = await index.search({
      companyId: COMPANY_ID,
      datasetIds: [DATASET_ID],
      text: NO_MATCH_TEXT,
      embedding: source.vector,
      limit: 10,
    });

    expect(hits[0]?.chunk.id).toBe(source.id);
    for (const hit of hits) expect(hit.chunk.datasetId).toBe(DATASET_ID);
    expect(recorded.filter(isIterativeScanSetting)).toHaveLength(1);
    expect(recorded.filter(isIndexStatement)).toHaveLength(1);
    expect(recorded.filter(isExactStatement)).toHaveLength(0);
    const exact = exactOrder(chunks, source.vector).slice(0, 10);
    expect(hits.map((hit) => hit.chunk.id).filter((id) => exact.includes(id)).length).toBeGreaterThanOrEqual(8);
  });

  it("ranks a small dataset exactly, over its own chunks, without the index", async () => {
    recorded.length = 0;
    const source = smallChunks[7];
    const noise = createRandom(99);
    const vector = l2Normalize(source.vector.map((value) => value + (noise() - 0.5) * 0.05));
    const hits = await index.search({
      companyId: COMPANY_ID,
      datasetIds: [SMALL_DATASET_ID],
      text: NO_MATCH_TEXT,
      embedding: vector,
      limit: 10,
    });

    // The dataset holds 30 chunks, far below exactSetMaxChunks: the size probe sent it straight to the
    // exact statement, and the answer is the exact cosine order of the dataset.
    expect(recorded.filter(isIndexStatement)).toHaveLength(0);
    expect(recorded.filter(isExactStatement)).toHaveLength(1);
    expect(hits.map((hit) => hit.chunk.id)).toEqual(exactOrder(smallChunks, vector).slice(0, 10));
    for (const hit of hits) expect(hit.chunk.datasetId).toBe(SMALL_DATASET_ID);
  });

  it("ranks a company of up to exactSetMaxChunks chunks exactly when the search names no dataset", async () => {
    // The stand holds about 2 000 chunks: below this threshold the company is small.
    const smallCompany = createPostgresSearchIndex({
      sql: executor,
      schema,
      ftsLanguage: FTS_LANGUAGE,
      exactSetMaxChunks: 5_000,
    });
    recorded.length = 0;
    const source = chunks[1203];
    const hits = await smallCompany.search({ companyId: COMPANY_ID, text: NO_MATCH_TEXT, embedding: source.vector, limit: 5 });

    expect(recorded.filter(isExactStatement)).toHaveLength(1);
    expect(recorded.filter(isIndexStatement)).toHaveLength(0);
    expect(hits[0]?.chunk.id).toBe(source.id);
    expect(hits.map((hit) => hit.chunk.id)).toEqual(exactOrder([...chunks, ...smallChunks], source.vector).slice(0, 5));
  });

  it("finds the chunk a question names by a number the OR of significant words drops", async () => {
    // "97" is shorter than the 4 characters of a significant word, and every chunk holds `document` and
    // `number`: only the question taken as a whole, every word mandatory, singles the chunk out.
    const hits = await index.search({ companyId: COMPANY_ID, datasetId: DATASET_ID, text: "the document number 97", limit: 5 });

    expect(hits[0]?.chunk.id).toBe(chunkId(97));
  });

  it("keeps what the question as a whole finds, next to the OR of its words", async () => {
    // The text of a chunk, word for word, as the hybrid recall test asks it: the chunk is in the full-text
    // leg at rank 1, whatever the many chunks that share all its words but the number.
    for (const position of [97, 391, 1009, 1500]) {
      const hits = await index.search({ companyId: COMPANY_ID, datasetId: DATASET_ID, text: chunkContent(position), limit: 5 });
      expect(hits[0]?.fusion.fullTextRank).toBe(1);
      expect(hits[0]?.chunk.id).toBe(chunkId(position));
    }
  });

  it("with exactSetMaxChunks 0 sends the small dataset through the iterative scan, and never ranks exactly", async () => {
    const indexOnly = createPostgresSearchIndex({
      sql: executor,
      schema,
      ftsLanguage: FTS_LANGUAGE,
      exactSetMaxChunks: 0,
    });
    recorded.length = 0;
    const source = smallChunks[7];
    const hits = await indexOnly.search({
      companyId: COMPANY_ID,
      datasetIds: [SMALL_DATASET_ID],
      text: NO_MATCH_TEXT,
      embedding: source.vector,
      limit: 10,
    });

    // No size probe and no exact statement: the scan returns what it finds of a dataset that holds 30
    // chunks of 2 000, and what it returns belongs to the dataset, the source chunk first.
    expect(recorded.filter(isIterativeScanSetting)).toHaveLength(1);
    expect(recorded.filter(isIndexStatement)).toHaveLength(1);
    expect(recorded.filter(isExactStatement)).toHaveLength(0);
    expect(hits[0]?.chunk.id).toBe(source.id);
    for (const hit of hits) expect(hit.chunk.datasetId).toBe(SMALL_DATASET_ID);
  });

  it("keeps the chunks of other datasets out of a dataset search whatever the scan visits", async () => {
    const source = smallChunks[3];
    const hits = await index.search({
      companyId: COMPANY_ID,
      datasetIds: [DATASET_ID],
      text: NO_MATCH_TEXT,
      embedding: source.vector,
      limit: 10,
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.chunk.datasetId).toBe(DATASET_ID);
    expect(hits.map((hit) => hit.chunk.id)).not.toContain(source.id);
  });

  it("searches the whole company through the iterative scan, with no dataset filter and no exact ranking", async () => {
    recorded.length = 0;
    const source = chunks[1203];
    const hits = await index.search({ companyId: COMPANY_ID, text: NO_MATCH_TEXT, embedding: source.vector, limit: 5 });

    expect(hits[0]?.chunk.id).toBe(source.id);
    expect(recorded.filter(isIndexStatement)).toHaveLength(1);
    expect(recorded.filter(isExactStatement)).toHaveLength(0);
  });

  it("reports a pgvector with the iterative scan, and uses it", async () => {
    const [{ extversion }] = await client.unsafe(`select extversion from pg_extension where extname = 'vector'`);
    expect(pgvectorHasIterativeScan(extversion)).toBe(true);
    recorded.length = 0;
    await index.search({ companyId: COMPANY_ID, datasetId: DATASET_ID, text: NO_MATCH_TEXT, embedding: chunks[5].vector, limit: 3 });
    expect(recorded.some((query) => /set local hnsw\.iterative_scan = relaxed_order/.test(query.text))).toBe(true);
  });

  it("uses the plain statement where pgvector is older than 0.8, and the transaction goes through", async () => {
    const oldPgvector = createPostgresSearchIndex({
      sql: withPgvectorBefore08(executor),
      schema,
      ftsLanguage: FTS_LANGUAGE,
    });
    recorded.length = 0;
    const source = chunks[777];
    const hits = await oldPgvector.search({
      companyId: COMPANY_ID,
      datasetIds: [DATASET_ID],
      text: NO_MATCH_TEXT,
      embedding: source.vector,
      limit: 5,
    });

    expect(recorded.filter(isExactStatement)).toHaveLength(0);
    expect(recorded.some((query) => /hnsw\.iterative_scan/.test(query.text))).toBe(false);
    expect(hits[0]?.chunk.id).toBe(source.id);
    for (const hit of hits) expect(hit.chunk.datasetId).toBe(DATASET_ID);
  });

  it("finds an identifier of 20 and more characters through the ilike match, which the tsvector does not", async () => {
    const withoutIlike = createPostgresSearchIndex({
      sql: executor,
      schema,
      ftsLanguage: FTS_LANGUAGE,
      ilikeMaxLength: 0,
    });
    // File names are one lexeme in the tsvector, so the name without its extension is not in it.
    for (const [identifier, tsvectorMisses] of [
      ["litellm_proxy_config", true],
      ["docker-compose-override", true],
      ["rq002_is_camp_chef_explorer", false],
    ] as const) {
      expect(identifier.length).toBeGreaterThanOrEqual(20);
      recorded.length = 0;
      const hits = await index.search({ companyId: COMPANY_ID, datasetIds: [SMALL_DATASET_ID], text: identifier, limit: 5 });
      expect(recorded.filter((query) => /ts_rank/.test(query.text) && /ilike/.test(query.text))).toHaveLength(1);
      expect(hits.map((hit) => hit.chunk.id)).toEqual([smallChunks[0].id]);

      if (tsvectorMisses) {
        const missed = await withoutIlike.search({ companyId: COMPANY_ID, datasetIds: [SMALL_DATASET_ID], text: identifier, limit: 5 });
        expect(missed).toEqual([]);
      }
    }
  });

  it("leaves a long question to the tsvector: no substring match, same answer", async () => {
    recorded.length = 0;
    const hits = await index.search({
      companyId: COMPANY_ID,
      datasetId: DATASET_ID,
      text: "unique marker number 3 in the corpus text for the hybrid search check",
      limit: 5,
    });

    const statements = recorded.filter((query) => /ts_rank/.test(query.text));
    expect(statements).toHaveLength(1);
    expect(statements[0].text).not.toMatch(/ilike/);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("finds the synthetic neighbours with recall@5 above the baseline", async () => {
    const queries = Array.from({ length: 20 }, (_, position) => Math.floor((position + 1) * 97) % chunks.length);
    const random = createRandom(7);
    let vectorFirst = 0;
    let vectorHits = 0;
    let noisyHits = 0;
    let hybridHits = 0;
    let plateauHits = 0;

    for (const position of queries) {
      const source = chunks[position];
      // A text nothing matches, so the fused list is the vector ranking by itself: this measures the
      // vector leg, not the fusion. The identical vector has distance 0, so it has to come back
      // first — and a stand that cannot do that is not a stand whose recall means anything.
      const vectorOnly = await index.search({
        companyId: COMPANY_ID,
        datasetId: DATASET_ID,
        text: NO_MATCH_TEXT,
        embedding: source.vector,
        limit: 5,
      });
      if (vectorOnly[0]?.chunk.id === source.id) vectorFirst += 1;
      if (vectorOnly.some((hit) => hit.chunk.id === source.id)) vectorHits += 1;

      const noisy = l2Normalize(source.vector.map((value) => value + (random() - 0.5) * 0.1));
      const noisyResult = await index.search({
        companyId: COMPANY_ID,
        datasetId: DATASET_ID,
        text: NO_MATCH_TEXT,
        embedding: noisy,
        limit: 5,
      });
      if (noisyResult.some((hit) => hit.chunk.id === source.id)) noisyHits += 1;

      // Both legs carry a signal here: the chunk's own wording matches only that chunk (its number is
      // a lexeme no other chunk has), and the vector is the chunk's own.
      const hybrid = await index.search({
        companyId: COMPANY_ID,
        datasetId: DATASET_ID,
        text: chunkContent(position),
        embedding: source.vector,
        limit: 5,
      });
      if (hybrid.some((hit) => hit.chunk.id === source.id)) hybridHits += 1;

      // The plateau case: wording every chunk shares, so the full-text ranks are a lottery and RRF
      // pulls the fused order away from the vector order. That is the fusion behaving as designed,
      // and it is the reason the recall figure is read off the vector ranking above rather than off
      // a text every chunk matches.
      const plateau = await index.search({
        companyId: COMPANY_ID,
        datasetId: DATASET_ID,
        text: "corpus text",
        embedding: source.vector,
        limit: 5,
      });
      if (plateau.some((hit) => hit.chunk.id === source.id)) plateauHits += 1;
    }

    const vectorRecall = vectorHits / queries.length;
    const noisyRecall = noisyHits / queries.length;
    const hybridRecall = hybridHits / queries.length;
    const plateauRecall = plateauHits / queries.length;
    console.log(
      `[corpus] recall@5 over ${chunks.length} chunks: vector=${vectorRecall.toFixed(4)} (first=${
        vectorFirst / queries.length
      }) noisy=${noisyRecall.toFixed(4)} hybrid=${hybridRecall.toFixed(4)} plateau=${plateauRecall.toFixed(4)}`,
    );
    // The vector ranking of an identical vector is exact, and the noisy query of the same 1024
    // dimensions only has to keep its own chunk in the top five.
    expect(vectorFirst).toBe(queries.length);
    expect(vectorRecall).toBeGreaterThanOrEqual(0.95);
    expect(noisyRecall).toBeGreaterThanOrEqual(0.9);
    // With a real text signal on both legs the fused list has to hold the source chunk.
    expect(hybridRecall).toBeGreaterThanOrEqual(0.95);
    // The plateau bound is deliberately soft — it catches a collapse of the fusion, not a bad draw.
    expect(plateauRecall).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps p95 latency inside the acceptance budget", async () => {
    const queries = Array.from({ length: 25 }, (_, position) => Math.floor((position + 3) * 61) % chunks.length);
    const durations: number[] = [];
    for (const position of queries) {
      const startedAt = performance.now();
      await index.search({
        companyId: COMPANY_ID,
        datasetId: DATASET_ID,
        text: "corpus text",
        embedding: chunks[position].vector,
        limit: 5,
      });
      durations.push(performance.now() - startedAt);
    }

    const p95 = percentile(durations, 0.95);
    console.log(
      `[corpus] hybrid search p95=${p95.toFixed(1)} ms over ${chunks.length} chunks (CORPUS_SEARCH_PERF_CHUNKS=${
        perfChunks > 0 ? perfChunks : "unset"
      }). For the acceptance number run the suite with CORPUS_SEARCH_PERF_CHUNKS=100000.`,
    );
    expect(p95).toBeLessThan(PERFORMANCE_BUDGET_MS);
  });

  it("reports the query plan of both rankings, straight from the product SQL", async () => {
    recorded.length = 0;
    await index.search({
      companyId: COMPANY_ID,
      datasetId: DATASET_ID,
      text: "unique marker number 3",
      embedding: chunks[7].vector,
      limit: 5,
    });

    const statements = recorded
      .map((query) => query.text.trim())
      .filter((text) => text.toLowerCase().startsWith("select"));
    expect(statements.length).toBeGreaterThanOrEqual(3);

    for (const statement of statements) {
      const plan = await client.unsafe(
        `explain (analyze, buffers) ${statement}`,
        (recorded.find((query) => query.text.trim() === statement)?.values ?? []) as Parameters<
          PgClient["unsafe"]
        >[1],
      );
      const lines = (plan as unknown as { "QUERY PLAN": string }[]).map((row) => row["QUERY PLAN"]);
      const ranking = plan.length > 0 ? lines.join("\n") : "";
      console.log(`[corpus] query plan (${chunks.length} chunks):\n${ranking}`);
      expect(ranking.length).toBeGreaterThan(0);
      expect(joinFilterEliminations(ranking)).toBeLessThan(chunks.length);
    }
  });
});