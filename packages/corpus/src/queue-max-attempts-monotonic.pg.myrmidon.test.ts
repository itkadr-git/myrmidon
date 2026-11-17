import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { PostgresWorkQueue } from "./postgres/queue.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

const support = await getEmbeddedPostgresTestSupport();
let pgvector: PgvectorInstall = { ok: false, reason: "not attempted", cleanup: async () => {} };
if (support.supported) pgvector = await installPgvectorIntoEmbeddedCluster();
const runnable = support.supported && pgvector.ok;
if (!runnable) console.warn(`queue monotonic tests skipped: ${support.supported ? pgvector.reason : support.reason}`);
afterAll(async () => { await pgvector.cleanup(); });

(runnable ? describe : describe.skip)("PostgresWorkQueue maxAttempts", () => {
  let testDb: EmbeddedPostgresTestDatabase;
  let store: PostgresCorpusStore;
  let queue: PostgresWorkQueue;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("corpus-queue-max-attempts-");
    const db = createDb(testDb.connectionString);
    store = new PostgresCorpusStore(db);
    queue = new PostgresWorkQueue(db);
  }, 120_000);

  afterAll(async () => { await testDb?.cleanup(); });

  it.each(["pending", "done"] as const)("keeps limits monotonic and versions independent for %s jobs", async (status) => {
    const db = createDb(testDb.connectionString);
    const companyId = crypto.randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'queue-test', 'QM')`);
    try {
      const dataset = await store.createDataset({ companyId, name: "queue" });
      const doc = await store.createDocument({ companyId, datasetId: dataset.id, title: "document.txt" });
      const input = { companyId, documentId: doc.id, parserVersion: "v1" };
      const first = await queue.enqueue({ ...input, maxAttempts: 3 });
      expect(first).toMatchObject({ status: "pending", maxAttempts: 3 });
      if (status === "done") {
        expect(await queue.claimNext(companyId)).toMatchObject({ id: first.id, status: "running" });
        await queue.complete(companyId, first.id);
      }
      const v2 = await queue.enqueue({ ...input, parserVersion: "v2", maxAttempts: 4 });
      expect(v2).toMatchObject({ parserVersion: "v2", status: "pending", maxAttempts: 4 });
      expect(v2.id).not.toBe(first.id);

      for (const [limit, expected] of [[1, 3], [5, 5], [2, 5], [7, 7]] as const) {
        const result = await queue.enqueue({ ...input, maxAttempts: limit });
        expect(result).toMatchObject({ id: first.id, parserVersion: "v1", status, maxAttempts: expected });
        expect(await queue.getJob(companyId, first.id)).toMatchObject({ id: first.id, status, maxAttempts: expected });
        expect(await queue.getJob(companyId, v2.id)).toMatchObject({ id: v2.id, status: "pending", maxAttempts: 4 });
        const jobs = await queue.listJobsForDocument(companyId, doc.id);
        expect(jobs).toHaveLength(2);
        expect(jobs).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: first.id, parserVersion: "v1", status, maxAttempts: expected }),
          expect.objectContaining({ id: v2.id, parserVersion: "v2", status: "pending", maxAttempts: 4 }),
        ]));
      }
      if (status === "done") {
        expect(await queue.claimNext(companyId)).toMatchObject({ id: v2.id });
        expect(await queue.claimNext(companyId)).toBeNull();
      }
    } finally {
      await db.execute(sql`delete from companies where id = ${companyId}`);
    }
  });
});
