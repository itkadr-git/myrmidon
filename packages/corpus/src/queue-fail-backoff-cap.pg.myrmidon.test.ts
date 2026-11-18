import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { PostgresWorkQueue } from "./postgres/queue.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

describe("PostgresWorkQueue.fail retry budget and backoff", () => {
  let cluster: EmbeddedPostgresTestDatabase | undefined;
  let pgvector: PgvectorInstall | undefined;

  beforeAll(async () => {
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(`pgvector unavailable: ${pgvector.reason}`);
    cluster = await startEmbeddedPostgresTestDatabase("corpus-fail-cap-");
  }, 120_000);

  afterAll(async () => {
    try {
      await cluster?.cleanup();
    } finally {
      await pgvector?.cleanup();
    }
  });

  async function runningJob(attempts: number, maxAttempts: number) {
    if (!cluster) throw new Error("Postgres did not start");
    const db = createDb(cluster.connectionString);
    const store = new PostgresCorpusStore(db);
    const queue = new PostgresWorkQueue(db);
    const companyId = crypto.randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'fail-cap', ${`F${companyId.replaceAll("-", "").slice(0, 12)}`})`);
    const dataset = await store.createDataset({ companyId, name: "fail-cap" });
    const doc = await store.createDocument({ companyId, datasetId: dataset.id, title: "fail.pdf" });
    const job = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1", maxAttempts });
    expect(await queue.claimNext(companyId)).toMatchObject({ id: job.id, status: "running", attempts: 1 });
    await db.execute(sql`update corpus_parse_jobs set attempts = ${attempts} where id = ${job.id} and company_id = ${companyId}`);
    const before = await queue.getJob(companyId, job.id);
    expect(before).toMatchObject({ id: job.id, status: "running", attempts, maxAttempts });
    expect(before?.startedAt).toBeInstanceOf(Date);
    return { queue, companyId, jobId: job.id, before: before! };
  }

  it.each([
    [1, 5_000],
    [2, 25_000],
    [3, 125_000],
    [4, 625_000],
    [5, 1_800_000],
    [6, 1_800_000],
  ])("schedules attempt %i with delay %i ms without spending another attempt", async (attempts, delay) => {
    const { queue, companyId, jobId } = await runningJob(attempts, 7);
    const now = Date.parse("2026-01-02T03:04:05.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await queue.fail(companyId, jobId, "parser timed out");
    } finally {
      clock.mockRestore();
    }
    const stored = await queue.getJob(companyId, jobId);
    expect(stored).toMatchObject({ id: jobId, status: "pending", attempts, maxAttempts: 7, lastError: "parser timed out", startedAt: null, finishedAt: null });
    expect(stored?.nextAttemptAt.getTime()).toBe(now + delay);
  });

  it.each([[3, 3], [4, 3]])("fails terminally at attempts %i with maxAttempts %i without scheduling retry", async (attempts, maxAttempts) => {
    const { queue, companyId, jobId, before } = await runningJob(attempts, maxAttempts);
    await queue.fail(companyId, jobId, "parser crashed");
    const stored = await queue.getJob(companyId, jobId);
    expect(stored).toMatchObject({ id: jobId, status: "failed", attempts, maxAttempts, lastError: "parser crashed" });
    expect(stored?.finishedAt).toBeInstanceOf(Date);
    expect(stored?.nextAttemptAt.getTime()).toBe(before.nextAttemptAt.getTime());
  });
});
