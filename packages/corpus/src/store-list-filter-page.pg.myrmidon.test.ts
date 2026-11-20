import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";
import type { CorpusDocumentListFilter } from "./ports.js";

const support = await getEmbeddedPostgresTestSupport();
let pgvector: PgvectorInstall = { ok: false, reason: "not attempted", cleanup: async () => {} };
if (support.supported) pgvector = await installPgvectorIntoEmbeddedCluster();
const runnable = support.supported && pgvector.ok;
if (!runnable) console.warn(`corpus list tests skipped: ${support.supported ? pgvector.reason : support.reason}`);
afterAll(async () => { await pgvector.cleanup(); });

(runnable ? describe : describe.skip)("document filters and pagination on embedded Postgres", () => {
  let testDb: EmbeddedPostgresTestDatabase;
  let store: PostgresCorpusStore;
  let companyA: string;
  let companyB: string;
  let datasetA: string;
  let datasetA2: string;
  let datasetB: string;
  let ids: string[];

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("corpus-list-pg-test-");
    const db = createDb(testDb.connectionString);
    store = new PostgresCorpusStore(db);
    companyA = crypto.randomUUID();
    companyB = crypto.randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values
      (${companyA}, 'list-a', 'LA'), (${companyB}, 'list-b', 'LB')`);
    datasetA = (await store.createDataset({ companyId: companyA, name: "a" })).id;
    datasetA2 = (await store.createDataset({ companyId: companyA, name: "a2" })).id;
    datasetB = (await store.createDataset({ companyId: companyB, name: "b" })).id;
    const specs = [
      { companyId: companyA, datasetId: datasetA, status: "queued" },
      { companyId: companyA, datasetId: datasetA2, status: "ready" },
      { companyId: companyB, datasetId: datasetB, status: "queued" },
      { companyId: companyA, datasetId: datasetA, status: "ready" },
      { companyId: companyA, datasetId: datasetA, status: "failed" },
      { companyId: companyB, datasetId: datasetB, status: "ready" },
      { companyId: companyA, datasetId: datasetA, status: "ready" },
    ] as const;
    ids = [];
    for (const [index, spec] of specs.entries()) {
      const doc = await store.createDocument({ companyId: spec.companyId, datasetId: spec.datasetId, title: `doc-${index}` });
      ids.push(doc.id);
      const timestamp = new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString();
      await db.execute(sql`update corpus_documents set status = ${spec.status}, created_at = ${timestamp}::timestamptz where id = ${doc.id}`);
    }
  }, 120_000);

  afterAll(async () => { await testDb?.cleanup(); });

  async function expectIds(filter: CorpusDocumentListFilter, expected: string[]) {
    expect((await store.listDocuments(filter)).map((doc) => doc.id)).toEqual(expected);
  }

  it("composes company, dataset and status filters in descending creation order", async () => {
    await expectIds({ companyId: companyA }, [ids[6]!, ids[4]!, ids[3]!, ids[1]!, ids[0]!]);
    await expectIds({ companyId: companyB }, [ids[5]!, ids[2]!]);
    await expectIds({ companyId: companyA, datasetId: datasetA }, [ids[6]!, ids[4]!, ids[3]!, ids[0]!]);
    await expectIds({ companyId: companyA, status: "ready" }, [ids[6]!, ids[3]!, ids[1]!]);
    await expectIds({ companyId: companyA, datasetId: datasetA, status: "ready" }, [ids[6]!, ids[3]!]);
    await expectIds({ companyId: companyA, datasetId: datasetA, status: "queued" }, [ids[0]!]);
    await expectIds({ companyId: companyA, datasetId: datasetA, status: "failed" }, [ids[4]!]);
    await expectIds({ companyId: companyB, datasetId: datasetA, status: "ready" }, []);
    await expectIds({ companyId: companyA, datasetId: datasetA2, status: "failed" }, []);
  });

  it("applies limit and offset after filtering without changing stored results", async () => {
    const filter = { companyId: companyA, datasetId: datasetA, status: "ready" } as const;
    await expectIds(filter, [ids[6]!, ids[3]!]);
    await expectIds({ ...filter, limit: 0 }, []);
    await expectIds({ ...filter, limit: 1, offset: 0 }, [ids[6]!]);
    await expectIds({ ...filter, limit: 1, offset: 1 }, [ids[3]!]);
    await expectIds({ ...filter, limit: 1, offset: 2 }, []);
    await expectIds({ ...filter, offset: 1 }, [ids[3]!]);
    await expectIds(filter, [ids[6]!, ids[3]!]);
  });
});
