import { sql as drizzleSql } from "drizzle-orm";

import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toPgVectorLiteral } from "./vector.js";
import { CORPUS_EMBEDDING_DIMENSIONS, l2Normalize } from "./vector.js";
import { createPostgresSearchIndex, type SqlExecutor } from "./hybrid-search-index.js";

// Integration stand for the hybrid search: a real PostgreSQL with pgvector, seeded with synthetic
// chunks, driven through the same SQL the product uses. The suite skips itself (loudly) when the
// local embedded Postgres has no pgvector extension — the extension is part of the stand, not of
// this package.
//
// `CORPUS_SEARCH_PERF_CHUNKS` scales the synthetic corpus; the acceptance number (p95 under 2 s
// for 10^5 chunks) is measured by running this suite with CORPUS_SEARCH_PERF_CHUNKS=100000.

const PERFORMANCE_BUDGET_MS = 2_000;
const DEFAULT_STAND_CHUNKS = 2_000;
const perfChunks = Number.parseInt(process.env.CORPUS_SEARCH_PERF_CHUNKS ?? "", 10);
const standChunks = Number.isInteger(perfChunks) && perfChunks > 0 ? perfChunks : DEFAULT_STAND_CHUNKS;

const INSERT_BATCH = 200;
const COMPANY_ID = "aaaaaaaa-0000-0000-0000-0000000000c1";
const DATASET_ID = "bbbbbbbb-0000-0000-0000-0000000000d1";
const OTHER_DATASET_ID = "bbbbbbbb-0000-0000-0000-0000000000d2";

const schema = {
  chunksTable: "corpus_search_probe_chunks",
  documentsTable: "corpus_search_probe_documents",
  contentColumn: "content",
  fullTextColumn: "content_tsv",
  embeddingColumn: "embedding",
};

interface StandChunk {
  readonly id: string;
  readonly vector: number[];
  readonly content: string;
}

interface Stand {
  readonly database: { connectionString: string; cleanup(): Promise<void> };
  readonly chunks: readonly StandChunk[];
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

async function resolveStand(): Promise<{ stand?: Stand; skipped?: string }> {
  const support = await getEmbeddedPostgresTestSupport();
  if (!support.supported) return { skipped: support.reason ?? "embedded Postgres is not supported on this platform" };

  let database: { connectionString: string; cleanup(): Promise<void> };
  try {
    database = await startEmbeddedPostgresTestDatabase("corpus-search");
  } catch (error) {
    return { skipped: `embedded Postgres did not start: ${error instanceof Error ? error.message : String(error)}` };
  }

  const db = createDb(database.connectionString);
  try {
    await db.execute(drizzleSql.unsafe(`create extension if not exists vector`));
    await db.execute(drizzleSql.unsafe(`create extension if not exists pg_trgm`));
  } catch (error) {
    await database.cleanup();
    return {
      skipped: `embedded Postgres has no pgvector/pg_trgm: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const chunks = await seedStand(db);
  return { stand: { database, chunks } };
}

async function seedStand(db: Db): Promise<StandChunk[]> {
  await db.execute(
    drizzleSql.unsafe(`
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
    `),
  );

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
        `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}::uuid, $${base + 5}::integer, $${base + 6}::text, to_tsvector('russian', $${base + 7}::text), $${base + 8}::vector)`,
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
    await db.execute(
      drizzleSql.unsafe(
        `insert into ${schema.documentsTable} (id, company_id, dataset_id, title, source_uri) values ${documentTuples.join(", ")}`,
        documentValues,
      ),
    );
    await db.execute(
      drizzleSql.unsafe(
        `insert into ${schema.chunksTable} (id, company_id, dataset_id, document_id, ordinal, content, content_tsv, embedding) values ${chunkTuples.join(", ")}`,
        chunkValues,
      ),
    );
  }

  // One chunk in a second dataset, with the same text as the first one: a search filtered by
  // dataset must never return it.
  await db.execute(
    drizzleSql.unsafe(
      `insert into ${schema.documentsTable} (id, company_id, dataset_id, title, source_uri) values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text)`,
      [documentId(2_000_000), COMPANY_ID, OTHER_DATASET_ID, "Foreign document", "file:///other.pdf"],
    ),
  );
  await db.execute(
    drizzleSql.unsafe(
      `insert into ${schema.chunksTable} (id, company_id, dataset_id, document_id, ordinal, content, content_tsv, embedding) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6::text, to_tsvector('russian', $7::text), $8::vector)`,
      [
        "eeeeeeee-0000-0000-0000-000000000001",
        COMPANY_ID,
        OTHER_DATASET_ID,
        documentId(2_000_000),
        0,
        chunkContent(0),
        chunkContent(0),
        toPgVectorLiteral(chunks[0].vector),
      ],
    ),
  );

  return chunks;
}

/** `SqlExecutor` over a drizzle client (the product wires its own executor). */
function executorFromDb(db: Db): SqlExecutor {
  return {
    query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) =>
      (await db.execute(drizzleSql.unsafe(text, [...values]))) as Row[],
    withTransaction: (run) => db.transaction(async (transaction) => run(executorFromDb(transaction as unknown as Db))),
  };
}

let stand: Stand | undefined;
let skipped: string | undefined;
try {
  const resolved = await resolveStand();
  stand = resolved.stand;
  skipped = resolved.skipped;
} catch (error) {
  skipped = `integration stand failed to set up: ${error instanceof Error ? error.message : String(error)}`;
}

if (skipped !== undefined) {
  console.warn(`[corpus] hybrid search integration tests skipped: ${skipped}`);
}

const suite = skipped === undefined ? describe : describe.skip;

suite("hybrid search over embedded postgres with pgvector", () => {
  let db: Db;
  let index: ReturnType<typeof createPostgresSearchIndex>;

  beforeAll(async () => {
    db = createDb(stand!.database.connectionString);
    index = createPostgresSearchIndex({ sql: executorFromDb(db), schema });
  });

  afterAll(async () => {
    await stand?.database.cleanup();
  });

  it("returns the top-k with score, chunk and document for a text query", async () => {
    const hits = await index.search({
      companyId: COMPANY_ID,
      datasetId: DATASET_ID,
      queryText: "unique marker number 3",
      embedding: stand!.chunks[7].vector,
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
      embedding: stand!.chunks[0].vector,
      limit: 10,
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.chunk.datasetId).toBe(DATASET_ID);
    expect(hits.map((hit) => hit.chunk.id)).not.toContain("eeeeeeee-0000-0000-0000-000000000001");
  });

  it("finds the synthetic neighbours with recall@5 above the baseline", async () => {
    const queries = Array.from({ length: 20 }, (_, position) => Math.floor((position + 1) * 97) % stand!.chunks.length);
    const random = createRandom(7);
    let exactHits = 0;
    let noisyHits = 0;

    for (const position of queries) {
      const source = stand!.chunks[position];
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
      `[corpus] recall@5 over ${stand!.chunks.length} chunks: exact=${exactRecall.toFixed(4)} noisy=${noisyRecall.toFixed(4)}`,
    );
    expect(exactRecall).toBeGreaterThanOrEqual(0.95);
    expect(noisyRecall).toBeGreaterThanOrEqual(0.8);
  });

  it("keeps p95 latency inside the acceptance budget", async () => {
    const queries = Array.from({ length: 25 }, (_, position) => Math.floor((position + 3) * 61) % stand!.chunks.length);
    const durations: number[] = [];
    for (const position of queries) {
      const startedAt = performance.now();
      await index.search({
        companyId: COMPANY_ID,
        datasetId: DATASET_ID,
        queryText: "corpus text",
        embedding: stand!.chunks[position].vector,
        limit: 5,
      });
      durations.push(performance.now() - startedAt);
    }

    const p95 = percentile(durations, 0.95);
    console.log(
      `[corpus] hybrid search p95=${p95.toFixed(1)} ms over ${stand!.chunks.length} chunks (perf chunks env=${perfChunks || "unset"})`,
    );
    expect(p95).toBeLessThan(PERFORMANCE_BUDGET_MS);
  });
});