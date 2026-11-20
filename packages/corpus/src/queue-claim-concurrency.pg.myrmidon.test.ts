import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@myrmidon/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { PostgresWorkQueue } from "./postgres/queue.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

describe("Postgres queue concurrent claims", () => {
  let testDb: EmbeddedPostgresTestDatabase | undefined;
  let vector: PgvectorInstall | undefined;
  let db: ReturnType<typeof createDb>;
  let first: PostgresWorkQueue;
  let second: PostgresWorkQueue;
  let store: PostgresCorpusStore;

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(`Embedded PostgreSQL unavailable: ${support.reason}`);
    vector = await installPgvectorIntoEmbeddedCluster();
    if (!vector.ok) throw new Error(`pgvector unavailable: ${vector.reason}`);
    testDb = await startEmbeddedPostgresTestDatabase("corpus-claim-concurrency-");
    db = createDb(testDb.connectionString, { maxConnections: 1 });
    const otherDb = createDb(testDb.connectionString, { maxConnections: 1 });
    const [a, b] = await Promise.all([
      db.execute(sql`select pg_backend_pid() as pid`),
      otherDb.execute(sql`select pg_backend_pid() as pid`),
    ]);
    expect((a as unknown as { pid: number }[])[0]?.pid).not.toBe((b as unknown as { pid: number }[])[0]?.pid);
    first = new PostgresWorkQueue(db);
    second = new PostgresWorkQueue(otherDb);
    store = new PostgresCorpusStore(db);
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb?.cleanup();
    } finally {
      await vector?.cleanup();
    }
  });

  async function company() {
    const companyId = crypto.randomUUID();
    const prefix = `C${companyId.replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'claim test', ${prefix})`);
    const dataset = await store.createDataset({ companyId, name: "claim test" });
    return { companyId, datasetId: dataset.id };
  }

  async function enqueue(fixture: { companyId: string; datasetId: string }) {
    const doc = await store.createDocument({ ...fixture, title: crypto.randomUUID() });
    return first.enqueue({ companyId: fixture.companyId, documentId: doc.id, parserVersion: "v1" });
  }

  it("claims two due jobs once each from independent sessions", async () => {
    const { companyId, datasetId } = await company();
    const jobs = await Promise.all([enqueue({ companyId, datasetId }), enqueue({ companyId, datasetId })]);
    const claimed = await Promise.all([first.claimNext(companyId), second.claimNext(companyId)]);
    expect(claimed.map((job) => job?.id).sort()).toEqual(jobs.map((job) => job.id).sort());
    for (const job of claimed) expect(job).toMatchObject({ status: "running", attempts: 1 });
    for (const job of jobs) expect(await first.getJob(companyId, job.id)).toMatchObject({ status: "running", attempts: 1 });
    expect(await first.claimNext(companyId)).toBeNull();
  });

  it("allows only one claimant to take a single job", async () => {
    const fixture = await company();
    const job = await enqueue(fixture);
    const claimed = await Promise.all([first.claimNext(fixture.companyId), second.claimNext(fixture.companyId)]);
    expect(claimed.filter((value) => value === null)).toHaveLength(1);
    expect(claimed.filter((value) => value !== null)).toEqual([expect.objectContaining({ id: job.id, status: "running", attempts: 1 })]);
    expect(await second.getJob(fixture.companyId, job.id)).toMatchObject({ status: "running", attempts: 1 });
    expect(await first.claimNext(fixture.companyId)).toBeNull();
  });

  it("respects the explicit cutoff and company boundary without changing excluded jobs", async () => {
    const own = await company();
    const foreign = await company();
    const due = await enqueue(own);
    const future = await enqueue(own);
    const foreignJob = await enqueue(foreign);
    const cutoff = new Date("2030-01-01T00:00:00.000Z");
    await db.execute(sql`update corpus_parse_jobs set next_attempt_at = '2029-01-01T00:00:00Z' where id in (${due.id}, ${foreignJob.id})`);
    await db.execute(sql`update corpus_parse_jobs set next_attempt_at = '2031-01-01T00:00:00Z' where id = ${future.id}`);
    expect(await first.claimNext(own.companyId, cutoff)).toMatchObject({ id: due.id, status: "running", attempts: 1 });
    expect(await second.claimNext(own.companyId, cutoff)).toBeNull();
    expect(await first.claimNext(own.companyId, cutoff)).toBeNull();
    expect(await first.getJob(own.companyId, due.id)).toMatchObject({ status: "running", attempts: 1 });
    expect(await first.getJob(own.companyId, future.id)).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: new Date("2031-01-01T00:00:00.000Z") });
    expect(await second.getJob(foreign.companyId, foreignJob.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await second.claimNext(foreign.companyId, cutoff)).toMatchObject({ id: foreignJob.id, status: "running", attempts: 1 });
    expect(await first.claimNext(own.companyId, new Date("2032-01-01T00:00:00.000Z"))).toMatchObject({ id: future.id, status: "running", attempts: 1 });
  });
});
