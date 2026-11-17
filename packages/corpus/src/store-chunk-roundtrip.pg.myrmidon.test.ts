import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./domain.js";
import { PostgresCorpusStore } from "./postgres/store.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

const embedding = (value: number) => Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, () => value);

describe("chunk replacement round trip on PostgreSQL", () => {
  let testDb: EmbeddedPostgresTestDatabase | undefined;
  let pgvector: PgvectorInstall | undefined;
  let store: PostgresCorpusStore;
  let companyId: string;
  let otherCompanyId: string;
  let documentId: string;
  let otherDocumentId: string;

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(`embedded PostgreSQL unavailable: ${support.reason}`);
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(`pgvector unavailable: ${pgvector.reason}`);
    testDb = await startEmbeddedPostgresTestDatabase("corpus-chunk-roundtrip-");
    const db = createDb(testDb.connectionString);
    store = new PostgresCorpusStore(db);
    companyId = crypto.randomUUID();
    otherCompanyId = crypto.randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values
      (${companyId}, 'chunk roundtrip', 'RT'), (${otherCompanyId}, 'other company', 'OT')`);
    const dataset = await store.createDataset({ companyId, name: "main" });
    documentId = (await store.createDocument({ companyId, datasetId: dataset.id, title: "main" })).id;
    otherDocumentId = (await store.createDocument({ companyId, datasetId: dataset.id, title: "other" })).id;
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb?.cleanup();
    } finally {
      await pgvector?.cleanup();
    }
  });

  it("orders and maps replacements, isolates documents and companies, and clears only the target", async () => {
    const other = await store.replaceDocumentChunks({ companyId, documentId: otherDocumentId, chunks: [
      { chunkIndex: 2, content: "other document", embedding: embedding(0.5), tokenCount: 4, metadata: { keep: true } },
    ] });
    expect(await store.listDocumentChunks(companyId, otherDocumentId)).toEqual(other);
    expect(await store.listDocumentChunks(companyId, documentId)).toEqual([]);

    const inserted = await store.replaceDocumentChunks({ companyId, documentId, chunks: [
      { chunkIndex: 7, content: "seven", embedding: embedding(0.75), tokenCount: 7, metadata: { page: 7, nested: { ok: true } } },
      { chunkIndex: 0, content: "zero", embedding: embedding(0.25), tokenCount: 0, metadata: { page: 0 } },
      { chunkIndex: 3, content: "three", embedding: null },
    ] });
    expect(inserted).toEqual([
      { id: expect.any(String), companyId, documentId, chunkIndex: 0, content: "zero", embedding: embedding(0.25), tokenCount: 0, metadata: { page: 0 }, createdAt: expect.any(Date) },
      { id: expect.any(String), companyId, documentId, chunkIndex: 3, content: "three", embedding: null, tokenCount: null, metadata: {}, createdAt: expect.any(Date) },
      { id: expect.any(String), companyId, documentId, chunkIndex: 7, content: "seven", embedding: embedding(0.75), tokenCount: 7, metadata: { page: 7, nested: { ok: true } }, createdAt: expect.any(Date) },
    ]);
    expect(await store.listDocumentChunks(companyId, documentId)).toEqual(inserted);
    expect(await store.listDocumentChunks(companyId, otherDocumentId)).toEqual(other);
    expect(await store.listDocumentChunks(otherCompanyId, documentId)).toEqual([]);

    const replacement = await store.replaceDocumentChunks({ companyId, documentId, chunks: [
      { chunkIndex: 3, content: "replacement", embedding: embedding(0.125), tokenCount: 1, metadata: { revision: 2 } },
    ] });
    expect(replacement).toEqual([
      { id: expect.any(String), companyId, documentId, chunkIndex: 3, content: "replacement", embedding: embedding(0.125), tokenCount: 1, metadata: { revision: 2 }, createdAt: expect.any(Date) },
    ]);
    expect(inserted.map((chunk) => chunk.id)).not.toContain(replacement[0]?.id);
    expect(await store.listDocumentChunks(companyId, documentId)).toEqual(replacement);
    expect(await store.listDocumentChunks(companyId, otherDocumentId)).toEqual(other);
    expect(await store.listDocumentChunks(otherCompanyId, documentId)).toEqual([]);

    expect(await store.replaceDocumentChunks({ companyId, documentId, chunks: [] })).toEqual([]);
    expect(await store.listDocumentChunks(companyId, documentId)).toEqual([]);
    expect(await store.listDocumentChunks(companyId, otherDocumentId)).toEqual(other);
    expect(await store.listDocumentChunks(otherCompanyId, documentId)).toEqual([]);
  });
});
