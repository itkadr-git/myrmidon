import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { CORPUS_EMBEDDING_DIMENSIONS } from "./domain.js";
import { PostgresCorpusStore } from "./postgres/store.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

const embedding = (value: number) => Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, () => value);

describe("chunk replacement transactions on PostgreSQL", () => {
  let testDb: EmbeddedPostgresTestDatabase | undefined;
  let pgvector: PgvectorInstall | undefined;
  let store: PostgresCorpusStore;
  let companyId: string;
  let documentId: string;
  let otherCompanyId: string;
  let otherDocumentId: string;

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(`embedded PostgreSQL unavailable: ${support.reason}`);
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(`pgvector unavailable: ${pgvector.reason}`);
    testDb = await startEmbeddedPostgresTestDatabase("corpus-chunk-rollback-");
    const db = createDb(testDb.connectionString);
    store = new PostgresCorpusStore(db);
    companyId = crypto.randomUUID();
    otherCompanyId = crypto.randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values
      (${companyId}, 'chunk rollback', 'CR'), (${otherCompanyId}, 'other company', 'OC')`);
    const dataset = await store.createDataset({ companyId, name: "main" });
    const otherDataset = await store.createDataset({ companyId: otherCompanyId, name: "other" });
    documentId = (await store.createDocument({ companyId, datasetId: dataset.id, title: "main" })).id;
    otherDocumentId = (await store.createDocument({ companyId: otherCompanyId, datasetId: otherDataset.id, title: "other" })).id;
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb?.cleanup();
    } finally {
      await pgvector?.cleanup();
    }
  });

  it("restores the entire previous snapshot after a PostgreSQL insert error, then replaces and clears it", async () => {
    await store.replaceDocumentChunks({ companyId, documentId, chunks: [
      { chunkIndex: 1, content: "second", embedding: embedding(0.5), tokenCount: 2, metadata: { page: 2 } },
      { chunkIndex: 0, content: "first", embedding: embedding(0.25), tokenCount: 1, metadata: { page: 1 } },
    ] });
    await store.replaceDocumentChunks({ companyId: otherCompanyId, documentId: otherDocumentId, chunks: [
      { chunkIndex: 0, content: "other tenant", embedding: embedding(0.75), metadata: { tenant: true } },
    ] });
    const snapshot = await store.listDocumentChunks(companyId, documentId);
    const otherSnapshot = await store.listDocumentChunks(otherCompanyId, otherDocumentId);
    expect(snapshot.map((chunk) => chunk.chunkIndex)).toEqual([0, 1]);
    expect(snapshot.map((chunk) => chunk.content)).toEqual(["first", "second"]);
    expect(snapshot[0]?.embedding).toEqual(embedding(0.25));
    expect(snapshot[1]?.metadata).toEqual({ page: 2 });

    // The second vector violates the actual vector column's fixed dimension.
    await expect(store.replaceDocumentChunks({ companyId, documentId, chunks: [
      { chunkIndex: 0, content: "valid replacement", embedding: embedding(0.125) },
      { chunkIndex: 1, content: "invalid replacement", embedding: [1, 2] },
    ] })).rejects.toThrow();
    expect(await store.listDocumentChunks(companyId, documentId)).toEqual(snapshot);
    expect(await store.listDocumentChunks(otherCompanyId, otherDocumentId)).toEqual(otherSnapshot);

    const replacement = await store.replaceDocumentChunks({ companyId, documentId, chunks: [
      { chunkIndex: 0, content: "replacement", embedding: embedding(0.125), metadata: { revision: 2 } },
    ] });
    expect(replacement).toHaveLength(1);
    expect(replacement[0]?.content).toBe("replacement");
    expect(replacement[0]?.id).not.toBe(snapshot[0]?.id);
    expect(await store.listDocumentChunks(companyId, documentId)).toEqual(replacement);
    expect(await store.listDocumentChunks(otherCompanyId, otherDocumentId)).toEqual(otherSnapshot);

    expect(await store.replaceDocumentChunks({ companyId, documentId, chunks: [] })).toEqual([]);
    expect(await store.listDocumentChunks(companyId, documentId)).toEqual([]);
    expect(await store.listDocumentChunks(otherCompanyId, otherDocumentId)).toEqual(otherSnapshot);
  });
});
