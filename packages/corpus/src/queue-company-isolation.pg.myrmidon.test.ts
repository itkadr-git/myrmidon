import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { PostgresWorkQueue } from "./postgres/queue.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

describe("Postgres queue company isolation", () => {
  let testDb: EmbeddedPostgresTestDatabase | undefined;
  let pgvector: PgvectorInstall | undefined;
  let queue: PostgresWorkQueue;
  let store: PostgresCorpusStore;
  const owner = crypto.randomUUID();
  const other = crypto.randomUUID();

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(support.reason ?? "embedded Postgres unsupported");
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(pgvector.reason);
    testDb = await startEmbeddedPostgresTestDatabase("corpus-isolation-pg-");
    const db = createDb(testDb.connectionString);
    store = new PostgresCorpusStore(db);
    queue = new PostgresWorkQueue(db);
    await db.execute(sql`insert into companies (id, name, issue_prefix) values
      (${owner}, 'queue owner', 'QOA'), (${other}, 'other company', 'QOB')`);
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb?.cleanup();
    } finally {
      await pgvector?.cleanup();
    }
  });

  it("prevents another company from reading or modifying a running job", async () => {
    const dataset = await store.createDataset({ companyId: owner, name: "isolation" });
    const doc = await store.createDocument({ companyId: owner, datasetId: dataset.id, title: "isolation.txt" });
    const job = await queue.enqueue({ companyId: owner, documentId: doc.id, parserVersion: "v1" });
    expect(await queue.claimNext(owner)).toMatchObject({ id: job.id, status: "running", attempts: 1 });
    const baseline = await queue.getJob(owner, job.id);
    expect(baseline).toMatchObject({ id: job.id, status: "running", attempts: 1 });
    expect(baseline?.startedAt).not.toBeNull();
    expect(await queue.listJobsForDocument(owner, doc.id)).toEqual([baseline]);

    expect(await queue.getJob(other, job.id)).toBeNull();
    expect(await queue.getJob(owner, job.id)).toEqual(baseline);
    expect(await queue.listJobsForDocument(other, doc.id)).toEqual([]);
    expect(await queue.getJob(owner, job.id)).toEqual(baseline);
    await queue.complete(other, job.id);
    expect(await queue.getJob(owner, job.id)).toEqual(baseline);
    await expect(queue.fail(other, job.id, "foreign failure")).rejects.toThrow(/not found/);
    expect(await queue.getJob(owner, job.id)).toEqual(baseline);
    expect(await queue.release(other, job.id, "foreign release")).toBeNull();
    expect(await queue.getJob(owner, job.id)).toEqual(baseline);

    await queue.complete(owner, job.id);
    expect(await queue.getJob(owner, job.id)).toMatchObject({ id: job.id, status: "done", attempts: 1, lastError: null, finishedAt: expect.any(Date) });
  });
});
