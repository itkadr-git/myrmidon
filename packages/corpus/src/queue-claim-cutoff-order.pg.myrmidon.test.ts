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

const support = await getEmbeddedPostgresTestSupport();
let pgvector: PgvectorInstall = { ok: false, reason: "not attempted", cleanup: async () => {} };
if (support.supported) pgvector = await installPgvectorIntoEmbeddedCluster();
const runnable = support.supported && pgvector.ok;
if (!runnable) console.warn(`queue cutoff tests skipped: ${support.supported ? pgvector.reason : support.reason}`);

afterAll(async () => { await pgvector.cleanup(); });

(runnable ? describe : describe.skip)("PostgresWorkQueue claim cutoff and order", () => {
  let testDb: EmbeddedPostgresTestDatabase;
  beforeAll(async () => { testDb = await startEmbeddedPostgresTestDatabase("corpus-claim-cutoff-"); }, 120_000);
  afterAll(async () => { await testDb?.cleanup(); });

  it("claims exactly due pending jobs in timestamp order and leaves other states untouched", async () => {
    const db = createDb(testDb.connectionString);
    const store = new PostgresCorpusStore(db);
    const queue = new PostgresWorkQueue(db);
    const companyId = crypto.randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'claim-cutoff', 'CC')`);
    const dataset = await store.createDataset({ companyId, name: "claim cutoff" });
    const cutoff = new Date("2025-01-01T00:00:10.000Z");
    const earlier = "2025-01-01T00:00:09.000Z";
    const boundary = cutoff.toISOString();
    const future = "2025-01-01T00:00:11.000Z";
    const oldCreated = "2025-01-01T00:00:00.000Z";
    const newCreated = "2025-01-01T00:00:01.000Z";

    async function job(name: string, due: string, created: string, status = "pending", attempts = 0) {
      const doc = await store.createDocument({ companyId, datasetId: dataset.id, title: name });
      const result = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1" });
      await db.execute(sql`update corpus_parse_jobs set next_attempt_at = ${due}::timestamptz,
        created_at = ${created}::timestamptz, status = ${status}, attempts = ${attempts}
        where company_id = ${companyId} and id = ${result.id}`);
      return result.id;
    }

    const exact = await job("exact", boundary, oldCreated, "pending", 2);
    expect(await queue.claimNext(companyId, new Date(cutoff.getTime() - 1))).toBeNull();
    const first = await queue.claimNext(companyId, cutoff);
    expect(first).toMatchObject({ id: exact, status: "running", attempts: 3 });
    expect(await queue.claimNext(companyId, cutoff)).toBeNull();

    // Insert in the opposite order to the expected timestamp order.
    const laterCreated = await job("tie later", boundary, newCreated, "pending", 1);
    const earlierCreated = await job("tie earlier", boundary, oldCreated, "pending", 2);
    const earliestDue = await job("earliest due", earlier, newCreated, "pending", 3);
    const futureId = await job("future", future, oldCreated, "pending", 4);
    const running = await job("running", earlier, oldCreated, "running", 5);
    const done = await job("done", earlier, oldCreated, "done", 6);
    const failed = await job("failed", earlier, oldCreated, "failed", 7);

    for (const [id, attempts] of [[earliestDue, 4], [earlierCreated, 3], [laterCreated, 2]] as const) {
      expect(await queue.claimNext(companyId, cutoff)).toMatchObject({ id, status: "running", attempts });
    }
    expect(await queue.claimNext(companyId, cutoff)).toBeNull();
    const rows = await db.execute(sql`select id, status, attempts from corpus_parse_jobs where company_id = ${companyId}`) as unknown as Array<{ id: string; status: string; attempts: number }>;
    for (const [id, status, attempts] of [
      [exact, "running", 3], [earliestDue, "running", 4], [earlierCreated, "running", 3],
      [laterCreated, "running", 2], [futureId, "pending", 4], [running, "running", 5],
      [done, "done", 6], [failed, "failed", 7],
    ] as const) {
      expect(rows.find((row) => row.id === id)).toMatchObject({ id, status, attempts });
    }
  });
});
