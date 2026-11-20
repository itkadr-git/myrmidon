import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@myrmidon/db";
import { CORPUS_DEFAULT_EMBEDDING_MODEL, CORPUS_EMBEDDING_DIMENSIONS } from "./domain.js";
import { PostgresCorpusStore } from "./postgres/store.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

describe("dataset round-trip on embedded Postgres", () => {
  let testDb: EmbeddedPostgresTestDatabase | undefined;
  let pgvector: PgvectorInstall | undefined;
  let store: PostgresCorpusStore;
  let db: ReturnType<typeof createDb>;
  const companyA = crypto.randomUUID();
  const companyB = crypto.randomUUID();

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(support.reason ?? "embedded Postgres unsupported");
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(pgvector.reason);
    testDb = await startEmbeddedPostgresTestDatabase("corpus-dataset-roundtrip-");
    db = createDb(testDb.connectionString);
    store = new PostgresCorpusStore(db);
    await db.execute(sql`insert into companies (id, name, issue_prefix) values
      (${companyA}, 'dataset-a', 'DA'), (${companyB}, 'dataset-b', 'DB')`);
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb?.cleanup();
    } finally {
      await pgvector?.cleanup();
    }
  });

  it("preserves defaults and explicit values with tenant-scoped reads and ordered lists", async () => {
    expect(await store.listDatasets(companyA)).toEqual([]);
    expect(await store.listDatasets(companyB)).toEqual([]);

    const defaults = await store.createDataset({ companyId: companyA, name: "defaults" });
    const explicit = await store.createDataset({ companyId: companyA, name: "explicit", description: "A description", embeddingModel: "custom-model" });
    const other = await store.createDataset({ companyId: companyB, name: "other", description: "B description", embeddingModel: "other-model" });
    for (const [dataset, companyId, name, description, embeddingModel] of [
      [defaults, companyA, "defaults", null, CORPUS_DEFAULT_EMBEDDING_MODEL],
      [explicit, companyA, "explicit", "A description", "custom-model"],
      [other, companyB, "other", "B description", "other-model"],
    ] as const) {
      expect(dataset).toEqual({
        id: expect.any(String), companyId, name, description, embeddingModel,
        embeddingDimensions: CORPUS_EMBEDDING_DIMENSIONS,
        createdAt: expect.any(Date), updatedAt: expect.any(Date),
      });
      expect(await store.getDataset(companyId, dataset.id)).toEqual(dataset);
    }
    expect(await store.getDataset(companyB, defaults.id)).toBeNull();
    expect(await store.getDataset(companyA, other.id)).toBeNull();
    expect(await store.getDataset(companyA, crypto.randomUUID())).toBeNull();

    // Set distinct timestamps in reverse creation order to make ordering deterministic.
    const earlier = new Date("2020-01-01T00:00:00.000Z");
    const later = new Date("2021-01-01T00:00:00.000Z");
    await db.execute(sql`update corpus_datasets set created_at = ${later.toISOString()} where id = ${defaults.id}`);
    await db.execute(sql`update corpus_datasets set created_at = ${earlier.toISOString()} where id = ${explicit.id}`);
    expect(await store.listDatasets(companyA)).toEqual([
      { ...explicit, createdAt: earlier },
      { ...defaults, createdAt: later },
    ]);
    expect(await store.listDatasets(companyB)).toEqual([other]);
    expect(await store.getDataset(companyA, explicit.id)).toEqual({ ...explicit, createdAt: earlier });
  });
});
