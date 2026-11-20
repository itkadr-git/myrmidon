import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { PostgresWorkQueue } from "./postgres/queue.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

describe("document deletion cascade on embedded PostgreSQL", () => {
  let testDb: EmbeddedPostgresTestDatabase;
  let pgvector: PgvectorInstall;

  beforeAll(async () => {
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(`pgvector unavailable: ${pgvector.reason}`);
    testDb = await startEmbeddedPostgresTestDatabase("corpus-delete-cascade-");
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb?.cleanup();
    } finally {
      await pgvector?.cleanup();
    }
  });

  it("deletes only the document's children and respects company ownership", async () => {
    const db = createDb(testDb.connectionString);
    const store = new PostgresCorpusStore(db);
    const queue = new PostgresWorkQueue(db);
    const companyId = crypto.randomUUID();
    const otherCompanyId = crypto.randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values
      (${companyId}, 'cascade owner', 'CD'), (${otherCompanyId}, 'other company', 'CO')`);
    const dataset = await store.createDataset({ companyId, name: "cascade" });
    const first = await store.createDocument({ companyId, datasetId: dataset.id, title: "first" });
    const second = await store.createDocument({ companyId, datasetId: dataset.id, title: "second" });
    const firstChunks = await store.replaceDocumentChunks({ companyId, documentId: first.id, chunks: [
      { chunkIndex: 0, content: "first chunk", embedding: null },
      { chunkIndex: 1, content: "another first chunk", embedding: null },
    ] });
    const secondChunks = await store.replaceDocumentChunks({ companyId, documentId: second.id, chunks: [
      { chunkIndex: 0, content: "second chunk", embedding: null },
    ] });
    const firstJob = await queue.enqueue({ companyId, documentId: first.id, parserVersion: "v1" });
    const secondJob = await queue.enqueue({ companyId, documentId: second.id, parserVersion: "v1" });

    async function children() {
      const chunks = await db.execute(sql`select id, document_id, chunk_index, content from corpus_chunks order by document_id, chunk_index`);
      const jobs = await db.execute(sql`select id, document_id, parser_version, status from corpus_parse_jobs order by document_id, parser_version`);
      return { chunks: Array.from(chunks), jobs: Array.from(jobs) };
    }
    const expectedChunks = [
      ...firstChunks.map((chunk) => ({ id: chunk.id, document_id: first.id, chunk_index: chunk.chunkIndex, content: chunk.content })),
      ...secondChunks.map((chunk) => ({ id: chunk.id, document_id: second.id, chunk_index: chunk.chunkIndex, content: chunk.content })),
    ].sort((a, b) => a.document_id.localeCompare(b.document_id) || a.chunk_index - b.chunk_index);
    const expectedJobs = [firstJob, secondJob].map((job) => ({ id: job.id, document_id: job.documentId, parser_version: job.parserVersion, status: job.status }))
      .sort((a, b) => a.document_id.localeCompare(b.document_id));
    const before = { chunks: expectedChunks, jobs: expectedJobs };
    expect(await children()).toEqual(before);
    expect(await store.deleteDocument(otherCompanyId, first.id)).toBe(false);
    expect(await store.getDocument(companyId, first.id)).toEqual(first);
    expect(await store.getDocument(companyId, second.id)).toEqual(second);
    expect(await children()).toEqual(before);

    expect(await store.deleteDocument(companyId, first.id)).toBe(true);
    expect(await store.getDocument(companyId, first.id)).toBeNull();
    expect(await store.getDocument(companyId, second.id)).toEqual(second);
    const remaining = {
      chunks: expectedChunks.filter((chunk) => chunk.document_id === second.id),
      jobs: expectedJobs.filter((job) => job.document_id === second.id),
    };
    expect(await children()).toEqual(remaining);
    expect(await store.deleteDocument(companyId, first.id)).toBe(false);
    expect(await store.getDocument(companyId, second.id)).toEqual(second);
    expect(await children()).toEqual(remaining);
  });
});
