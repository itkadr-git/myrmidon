import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

describe("document status details on embedded Postgres", () => {
  let testDb: EmbeddedPostgresTestDatabase | undefined;
  let pgvector: PgvectorInstall | undefined;
  let store: PostgresCorpusStore;
  let companyId: string;
  let otherCompanyId: string;
  let datasetId: string;

  beforeAll(async () => {
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(`pgvector unavailable: ${pgvector.reason}`);
    testDb = await startEmbeddedPostgresTestDatabase("corpus-status-details-");
    const db = createDb(testDb.connectionString);
    store = new PostgresCorpusStore(db);
    companyId = crypto.randomUUID();
    otherCompanyId = crypto.randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values
      (${companyId}, 'status-owner', 'SO'), (${otherCompanyId}, 'status-other', 'ST')`);
    datasetId = (await store.createDataset({ companyId, name: "status" })).id;
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    try { await testDb?.cleanup(); } finally { await pgvector?.cleanup(); }
  });

  it("preserves, replaces and clears details across legal transitions", async () => {
    const doc = await store.createDocument({ companyId, datasetId, title: "details" });
    expect(doc).toMatchObject({ status: "queued", parseError: null, parserVersion: null, parsedAt: null });
    const parsing = await store.updateDocumentStatus(companyId, doc.id, "parsing", { parseError: "first error", parserVersion: "v1" });
    expect(parsing).toMatchObject({ status: "parsing", parseError: "first error", parserVersion: "v1", parsedAt: null });
    const embedding = await store.updateDocumentStatus(companyId, doc.id, "embedding");
    expect(embedding).toMatchObject({ status: "embedding", parseError: "first error", parserVersion: "v1", parsedAt: null });
    const instant = new Date("2026-01-02T03:04:05.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant);
    try {
      const ready = await store.updateDocumentStatus(companyId, doc.id, "ready", { parseError: undefined, parserVersion: undefined });
      expect(ready).toMatchObject({ status: "ready", parseError: "first error", parserVersion: "v1", parsedAt: instant, updatedAt: instant });
      vi.setSystemTime(new Date("2026-01-03T03:04:05.000Z"));
      const queued = await store.updateDocumentStatus(companyId, doc.id, "queued", { parseError: "second error", parserVersion: "v2" });
      expect(queued).toMatchObject({ status: "queued", parseError: "second error", parserVersion: "v2", parsedAt: instant });
      const failed = await store.updateDocumentStatus(companyId, doc.id, "failed", { parseError: null, parserVersion: null });
      expect(failed).toMatchObject({ status: "failed", parseError: null, parserVersion: null, parsedAt: instant });
      const retry = await store.updateDocumentStatus(companyId, doc.id, "queued");
      expect(retry).toMatchObject({ status: "queued", parseError: null, parserVersion: null, parsedAt: instant });
      expect(await store.getDocument(companyId, doc.id)).toEqual(retry);
    } finally { vi.useRealTimers(); }
  });

  it("does not modify the row for illegal transitions or another company", async () => {
    const doc = await store.createDocument({ companyId, datasetId, title: "protected" });
    const before = await store.updateDocumentStatus(companyId, doc.id, "parsing", { parseError: "error", parserVersion: "v1" });
    expect(await store.getDocument(companyId, doc.id)).toEqual(before);
    await expect(store.updateDocumentStatus(companyId, doc.id, "ready", { parseError: null, parserVersion: null })).rejects.toThrow();
    expect(await store.getDocument(companyId, doc.id)).toEqual(before);
    await expect(store.updateDocumentStatus(otherCompanyId, doc.id, "embedding", { parseError: null, parserVersion: null })).rejects.toThrow();
    expect(await store.getDocument(companyId, doc.id)).toEqual(before);
    expect(await store.getDocument(otherCompanyId, doc.id)).toBeNull();
  });
});
