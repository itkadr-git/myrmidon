import postgres from "postgres";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresSearchIndex, type SqlExecutor } from "./hybrid-search-index.js";
import { CORPUS_EMBEDDING_DIMENSIONS, l2Normalize, toPgVectorLiteral } from "./vector.js";

// Hybrid search needs PostgreSQL with the `vector` and `pg_trgm` extensions, which the product
// database image does not carry yet (installer and compose still run plain `postgres:17-alpine`).
// The suite therefore runs against an external stand named by `CORPUS_TEST_PGVECTOR_DSN` and skips
// itself loudly, with the reason, when the variable is unset — CI runs the rest of the package and
// the vector part is exercised on a stand:
//
//   CORPUS_TEST_PGVECTOR_DSN=postgres://… pnpm --filter @paperclipai/corpus exec vitest run
//
// The stand must allow `CREATE EXTENSION`; everything else is created and dropped by this file in
// its own probe tables, so a shared stand keeps its own data. `CORPUS_SEARCH_PERF_CHUNKS` scales
// the synthetic corpus up to the acceptance size (10^5) for the latency measurement.

const DSN_ENV = "CORPUS_TEST_PGVECTOR_DSN";
// Text search configuration of the stand column and of the query; kept in one place so the seeded
// `tsvector` and the search cannot drift apart.
const FTS_LANGUAGE = "russian";
const PERFORMANCE_BUDGET_MS = 2_000;
const DEFAULT_STAND_CHUNKS = 2_000;
const perfChunks = Number.parseInt(process.env.CORPUS_SEARCH_PERF_CHUNKS ?? "", 10);
const standChunks = Number.isInteger(perfChunks) && perfChunks > 0 ? perfChunks : DEFAULT_STAND_CHUNKS;

const INSERT_BATCH = 200;
const COMPANY_ID = "aaaaaaaa-0000-0000-0000-0000000000c1";
const DATASET_ID = "bbbbbbbb-0000-0000-0000-0000000000d1";
const OTHER_DATASET_ID = "bbbbbbbb-0000-0000-0000-0000000000d2";
const FOREIGN_CHUNK_ID = "eeeeeeee-0000-0000-0000-000000000001";

const schema = {
  chunksTable: "corpus_search_probe_chunks",
  documentsTable: "corpus_search_probe_documents",
  contentColumn: "content",
  fullTextColumn: "content_tsv",
  embeddingColumn: "embedding",
} as const;

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

if (DSN === undefined || DSN === "") {
  console.warn(
    `[corpus] hybrid search integration suite SKIPPED: ${DSN_ENV} is not set, so no stand with the ` +
      `vector and pg_trgm extensions is named. The unit suite still covers the SQL and the fusion.`,
  );
} else {
  console.log(`[corpus] hybrid search integration suite runs against ${standTarget(DSN)}`);
}

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

/** `SqlExecutor` over postgres.js — the same narrow interface the product wires its own client to. */
function executorFromClient(client: PgClient, onQuery?: (query: RecordedQuery) => void): SqlExecutor {
  return {
    query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      onQuery?.({ text, values });
      const rows = await client.unsafe(text, values as Parameters<PgClient["unsafe"]>[1]);
      return rows as unknown as Row[];
    },
    withTransaction: <T>(run: (transaction: SqlExecutor) => Promise<T>) =>
      client.begin(async (transaction: unknown) =>
        run(executorFromClient(transaction as PgClient, onQuery)),
      ),
  };
}

async function seedStand(client: PgClient): Promise<StandChunk[]> {
  await client.unsafe(`drop table if exists ${schema.chunksTable} cascade`);
  await client.unsafe(`drop table if exists ${schema.documentsTable} cascade`);
  await client.unsafe(`
      create table ${schema.documentsTable} (
        id uuid primary key,
        company_id uuid not null,
        dataset_id uuid not null,
        title text,
        source_uri text
      );
      create table ${schema.chunksTable} (
        id uuid primary key,
        company_id uuid not null,
        dataset_id uuid not null,
        document_id uuid not null,
        ordinal integer not null,
        content text not null,
        content_tsv tsvector,
        embedding vector(${CORPUS_EMBEDDING_DIMENSIONS})
      );
      create index ${schema.chunksTable}_embedding_hnsw on ${schema.chunksTable}
        using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
      create index ${schema.chunksTable}_content_tsv_gin on ${schema.chunksTable} using gin (content_tsv);
      create index ${schema.chunksTable}_content_trgm_gin on ${schema.chunksTable} using gin (content gin_trgm_ops);
    `);

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
      const base = position * 8;
      chunkValues.push(
        chunk.id,
        COMPANY_ID,
        DATASET_ID,
        documentId(offset + position),
        offset + position,
        chunk.content,
        chunk.content,
        toPgVectorLiteral(chunk.vector),
      );
      chunkTuples.push(
        `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}::uuid, $${base + 5}::integer, $${base + 6}::text, to_tsvector('${FTS_LANGUAGE}', $${base + 7}::text), $${base + 8}::vector)`,
      );
      const documentBase = position * 5;
      documentValues.push(
        documentId(offset + position),
        COMPANY_ID,
        DATASET_ID,
        `Document ${offset + position}`,
        `file:///${offset + position}.pdf`,
      );
      documentTuples.push(
        `($${documentBase + 1}::uuid, $${documentBase + 2}::uuid, $${documentBase + 3}::uuid, $${documentBase + 4}::text, $${documentBase + 5}::text)`,
      );
    });
    await client.unsafe(
      `insert into ${schema.documentsTable} (id, company_id, dataset_id, title, source_uri) values ${documentTuples.join(", ")}`,
      documentValues as Parameters<PgClient["unsafe"]>[1],
    );
    await client.unsafe(
      `insert into ${schema.chunksTable} (id, company_id, dataset_id, document_id, ordinal, content, content_tsv, embedding) values ${chunkTuples.join(", ")}`,
      chunkValues as Parameters<PgClient["unsafe"]>[1],
    );
  }

  // One chunk in a second dataset, with the same text as the first one: a search filtered by
  // dataset must never return it.
  await client.unsafe(
    `insert into ${schema.documentsTable} (id, company_id, dataset_id, title, source_uri) values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text)`,
    [documentId(2_000_000), COMPANY_ID, OTHER_DATASET_ID, "Foreign document", "file:///other.pdf"] as Parameters<
      PgClient["unsafe"]
    >[1],
  );
  await client.unsafe(
    `insert into ${schema.chunksTable} (id, company_id, dataset_id, document_id, ordinal, content, content_tsv, embedding) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6::text, to_tsvector('${FTS_LANGUAGE}', $7::text), $8::vector)`,
    [
      FOREIGN_CHUNK_ID,
      COMPANY_ID,
      OTHER_DATASET_ID,
      documentId(2_000_000),
      0,
      chunkContent(0),
      chunkContent(0),
      toPgVectorLiteral(chunks[0].vector),
    ] as Parameters<PgClient["unsafe"]>[1],
  );

  return chunks;
}

const suite = describe.skipIf(DSN === undefined || DSN === "");

suite("hybrid search over an external postgres stand with pgvector", () => {
  let client: PgClient;
  let executor: SqlExecutor;
  let index: ReturnType<typeof createPostgresSearchIndex>;
  let chunks: StandChunk[];
  let recorded: RecordedQuery[];

  beforeAll(async () => {
    client = postgres(DSN as string, { max: 4 });
    await client.unsafe(`create extension if not exists vector`);
    await client.unsafe(`create extension if not exists pg_trgm`);
    chunks = await seedStand(client);
    recorded = [];
    executor = executorFromClient(client, (query) => recorded.push(query));
    index = createPostgresSearchIndex({ sql: executor, schema, ftsLanguage: FTS_LANGUAGE });
  });

  afterAll(async () => {
    await client.unsafe(`drop table if exists ${schema.chunksTable} cascade`);
    await client.unsafe(`drop table if exists ${schema.documentsTable} cascade`);
    await client.end();
  });

  it("returns the top-k with score, chunk and document for a text query", async () => {
    const hits = await index.search({
      companyId: COMPANY_ID,
      datasetId: DATASET_ID,
      queryText: "unique marker number 3",
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
      queryText: chunkContent(0),
      embedding: chunks[0].vector,
      limit: 10,
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.chunk.datasetId).toBe(DATASET_ID);
    expect(hits.map((hit) => hit.chunk.id)).not.toContain(FOREIGN_CHUNK_ID);
  });

  it("finds the synthetic neighbours with recall@5 above the baseline", async () => {
    const queries = Array.from({ length: 20 }, (_, position) => Math.floor((position + 1) * 97) % chunks.length);
    const random = createRandom(7);
    let exactHits = 0;
    let noisyHits = 0;

    for (const position of queries) {
      const source = chunks[position];
      const exact = await index.search({
        companyId: COMPANY_ID,
        datasetId: DATASET_ID,
        queryText: "corpus text",
        embedding: source.vector,
        limit: 5,
      });
      if (exact.some((hit) => hit.chunk.id === source.id)) exactHits += 1;

      const noisy = l2Normalize(source.vector.map((value) => value + (random() - 0.5) * 0.1));
      const noisyResult = await index.search({
        companyId: COMPANY_ID,
        datasetId: DATASET_ID,
        queryText: "corpus text",
        embedding: noisy,
        limit: 5,
      });
      if (noisyResult.some((hit) => hit.chunk.id === source.id)) noisyHits += 1;
    }

    const exactRecall = exactHits / queries.length;
    const noisyRecall = noisyHits / queries.length;
    console.log(
      `[corpus] recall@5 over ${chunks.length} chunks: exact=${exactRecall.toFixed(4)} noisy=${noisyRecall.toFixed(4)}`,
    );
    expect(exactRecall).toBeGreaterThanOrEqual(0.95);
    expect(noisyRecall).toBeGreaterThanOrEqual(0.8);
  });

  it("keeps p95 latency inside the acceptance budget", async () => {
    const queries = Array.from({ length: 25 }, (_, position) => Math.floor((position + 3) * 61) % chunks.length);
    const durations: number[] = [];
    for (const position of queries) {
      const startedAt = performance.now();
      await index.search({
        companyId: COMPANY_ID,
        datasetId: DATASET_ID,
        queryText: "corpus text",
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
      queryText: "unique marker number 3",
      embedding: chunks[7].vector,
      limit: 5,
    });

    const statements = recorded
      .map((query) => query.text.trim())
      .filter((text) => text.toLowerCase().startsWith("select"));
    expect(statements.length).toBeGreaterThanOrEqual(2);

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
    }
  });
});