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
if (!runnable) console.warn(`enqueue matrix skipped: ${support.supported ? pgvector.reason : support.reason}`);

afterAll(async () => { await pgvector.cleanup(); });

(runnable ? describe : describe.skip)("enqueue state matrix on PostgreSQL", () => {
  let testDb: EmbeddedPostgresTestDatabase;
  let db: ReturnType<typeof createDb>;
  let store: PostgresCorpusStore;
  let queue: PostgresWorkQueue;
  const companyId = crypto.randomUUID();
  let datasetId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("corpus-enqueue-matrix-");
    db = createDb(testDb.connectionString);
    store = new PostgresCorpusStore(db);
    queue = new PostgresWorkQueue(db);
    await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'enqueue matrix', 'EM')`);
    datasetId = (await store.createDataset({ companyId, name: "matrix" })).id;
  }, 120_000);

  afterAll(async () => {
    if (testDb) await testDb.cleanup();
  });

  for (const status of ["pending", "running", "done", "failed"] as const) {
    for (const reset of [false, true]) {
      it(`${status} with reset=${reset}`, async () => {
        const doc = await store.createDocument({ companyId, datasetId, title: `${status}-${reset}` });
        const input = { companyId, documentId: doc.id, parserVersion: "v1" };
        const first = await queue.enqueue(input);
        await db.execute(sql`
          update corpus_parse_jobs
          set status = ${status}, attempts = 2, last_error = 'old error',
              started_at = '2020-01-01T00:00:00Z'::timestamptz,
              finished_at = '2020-01-02T00:00:00Z'::timestamptz,
              next_attempt_at = now() + interval '1 day'
          where id = ${first.id} and company_id = ${companyId}
        `);
        const before = await queue.getJob(companyId, first.id);
        expect(before).toMatchObject({ id: first.id, status, attempts: 2, lastError: "old error", startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-02T00:00:00Z") });
        const clock = await db.execute(sql`select now() as now`) as unknown as { now: Date }[];
        expect(before!.nextAttemptAt.getTime()).toBeGreaterThan(new Date(clock[0]!.now).getTime());

        const result = await queue.enqueue({ ...input, reset });
        const readBack = await queue.getJob(companyId, first.id);
        expect(readBack).toEqual(result);
        const jobs = await queue.listJobsForDocument(companyId, doc.id);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toEqual(result);
        if (reset || status === "failed") {
          expect(result).toMatchObject({ id: first.id, status: "pending", attempts: 0, lastError: null, startedAt: null, finishedAt: null });
          const afterClock = await db.execute(sql`select now() as now`) as unknown as { now: Date }[];
          expect(result.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(new Date(clock[0]!.now).getTime());
          expect(result.nextAttemptAt.getTime()).toBeLessThanOrEqual(new Date(afterClock[0]!.now).getTime());
        } else {
          expect(result).toEqual(before);
        }
      });
    }
  }
});
