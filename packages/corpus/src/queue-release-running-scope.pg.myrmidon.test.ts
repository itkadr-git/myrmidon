import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { PARSE_JOB_INTERRUPTED_ERROR } from "./domain.js";
import { PostgresCorpusStore } from "./postgres/store.js";
import { PostgresWorkQueue } from "./postgres/queue.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

describe("releaseRunning company scope on PostgreSQL", () => {
  let testDb: EmbeddedPostgresTestDatabase | undefined;
  let pgvector: PgvectorInstall | undefined;

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(`embedded PostgreSQL unavailable: ${support.reason}`);
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(`pgvector unavailable: ${pgvector.reason}`);
    testDb = await startEmbeddedPostgresTestDatabase("corpus-release-scope-");
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb?.cleanup();
    } finally {
      await pgvector?.cleanup();
    }
  });

  it("releases only the selected company's running jobs, then releases the rest globally", async () => {
    if (!testDb) throw new Error("database was not started");
    const db = createDb(testDb.connectionString);
    const store = new PostgresCorpusStore(db);
    const queue = new PostgresWorkQueue(db);

    async function company(prefix: string) {
      const companyId = crypto.randomUUID();
      await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, ${prefix}, ${prefix})`);
      const dataset = await store.createDataset({ companyId, name: prefix });
      return { companyId, datasetId: dataset.id };
    }
    async function enqueue(owner: { companyId: string; datasetId: string }, title: string, maxAttempts = 3) {
      const doc = await store.createDocument({ ...owner, title });
      return queue.enqueue({ companyId: owner.companyId, documentId: doc.id, parserVersion: "v1", maxAttempts });
    }
    async function claim(owner: { companyId: string }, jobId: string) {
      expect(await queue.claimNext(owner.companyId)).toMatchObject({ id: jobId, status: "running", attempts: 1 });
    }
    async function snapshot(companyId: string) {
      const result = await db.execute(sql`
        select row_to_json(j)::text as row from corpus_parse_jobs j
        where company_id = ${companyId} order by id
      `);
      return (result as unknown as { row: string }[]).map((r) => r.row);
    }
    async function row(jobId: string) {
      const result = await db.execute(sql`select row_to_json(j)::text as row from corpus_parse_jobs j where id = ${jobId}`);
      return (result as unknown as { row: string }[])[0]?.row;
    }

    const a = await company("RRA");
    const b = await company("RRB");
    const retryA = await enqueue(a, "retry-a");
    await claim(a, retryA.id);
    const exhaustedA = await enqueue(a, "exhausted-a", 1);
    await claim(a, exhaustedA.id);
    const runningB = await enqueue(b, "running-b");
    await claim(b, runningB.id);

    const protectedA = [];
    for (const owner of [a, b]) {
      const done = await enqueue(owner, "done");
      await claim(owner, done.id);
      await queue.complete(owner.companyId, done.id);
      const failed = await enqueue(owner, "failed", 1);
      await claim(owner, failed.id);
      await queue.fail(owner.companyId, failed.id, "fixture failure");
      const pending = await enqueue(owner, "pending");
      if (owner === a) protectedA.push(done.id, failed.id, pending.id);
    }
    const beforeB = await snapshot(b.companyId);
    const beforeA = await Promise.all(protectedA.map(row));
    expect(beforeB).toHaveLength(4);
    expect(beforeA).toHaveLength(3);
    expect(beforeA.every(Boolean)).toBe(true);

    const released = await queue.releaseRunning({ companyId: a.companyId });
    expect(released.map((job) => job.id).sort()).toEqual([retryA.id, exhaustedA.id].sort());
    expect(await queue.getJob(a.companyId, retryA.id)).toMatchObject({ status: "pending", attempts: 1, lastError: PARSE_JOB_INTERRUPTED_ERROR, startedAt: null, finishedAt: null });
    const exhausted = await queue.getJob(a.companyId, exhaustedA.id);
    expect(exhausted).toMatchObject({ status: "failed", attempts: 1, lastError: PARSE_JOB_INTERRUPTED_ERROR });
    expect(exhausted?.finishedAt).not.toBeNull();
    expect(await snapshot(b.companyId)).toEqual(beforeB);
    expect(await Promise.all(protectedA.map(row))).toEqual(beforeA);
    expect(await queue.releaseRunning({ companyId: a.companyId })).toEqual([]);
    expect(await snapshot(b.companyId)).toEqual(beforeB);
    expect(await Promise.all(protectedA.map(row))).toEqual(beforeA);

    const global = await queue.releaseRunning();
    expect(global.map((job) => job.id)).toEqual([runningB.id]);
    expect(await queue.getJob(b.companyId, runningB.id)).toMatchObject({ status: "pending", attempts: 1, lastError: PARSE_JOB_INTERRUPTED_ERROR, startedAt: null });
    expect(await Promise.all(protectedA.map(row))).toEqual(beforeA);
  });
});
