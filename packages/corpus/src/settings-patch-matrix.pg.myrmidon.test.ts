import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@myrmidon/db";
import { CORPUS_DEFAULT_SETTINGS, type CorpusModuleSettings } from "./domain.js";
import { PostgresCorpusSettingsStore } from "./postgres/settings.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

describe("corpus settings patches on PostgreSQL", () => {
  let testDb: EmbeddedPostgresTestDatabase | undefined;
  let pgvector: PgvectorInstall | undefined;
  let store: PostgresCorpusSettingsStore;
  const companyId = crypto.randomUUID();
  const otherCompanyId = crypto.randomUUID();
  const firstInsertCompanyId = crypto.randomUUID();

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(support.reason ?? "embedded PostgreSQL unsupported");
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(pgvector.reason ?? "pgvector unavailable");
    testDb = await startEmbeddedPostgresTestDatabase("corpus-settings-patch-");
    const db = createDb(testDb.connectionString);
    await db.execute(sql`
      insert into companies (id, name, issue_prefix) values
        (${companyId}, 'settings matrix', 'SM'),
        (${otherCompanyId}, 'settings control', 'SC'),
        (${firstInsertCompanyId}, 'settings defaults', 'SD')
    `);
    store = new PostgresCorpusSettingsStore(db);
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb?.cleanup();
    } finally {
      await pgvector?.cleanup();
    }
  });

  it("preserves every other field and another company after each partial patch", async () => {
    const initial: CorpusModuleSettings = {
      enabled: true,
      defaultEmbedderBaseUrl: "https://embed.example",
      defaultEmbeddingModel: "embed-model",
      defaultParserUrl: "https://parser.example",
      defaultParserVersion: "parser-v1",
      blobStoreRoot: "/corpus/blobs",
      extra: { keep: "original", nested: { old: true } },
    };
    const control = { ...initial, defaultEmbeddingModel: "other-company" };
    expect(await store.updateSettings(companyId, initial)).toEqual(initial);
    expect(await store.updateSettings(otherCompanyId, control)).toEqual(control);
    expect(await store.getSettings(companyId)).toEqual(initial);
    expect(await store.getSettings(otherCompanyId)).toEqual(control);

    const patches: Partial<CorpusModuleSettings>[] = [
      { enabled: false },
      { defaultEmbedderBaseUrl: null },
      { defaultParserUrl: null },
      { blobStoreRoot: null },
      { defaultParserVersion: "" },
      { defaultEmbeddingModel: "" },
      { defaultEmbedderBaseUrl: "" },
      { defaultParserUrl: "" },
      { blobStoreRoot: "" },
      { extra: { replacement: true } },
      { extra: {} },
      { enabled: undefined, defaultEmbedderBaseUrl: undefined, defaultEmbeddingModel: undefined,
        defaultParserUrl: undefined, defaultParserVersion: undefined, blobStoreRoot: undefined,
        extra: undefined },
    ];
    let expected = initial;
    for (const patch of patches) {
      const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      expected = { ...expected, ...defined };
      expect(await store.updateSettings(companyId, patch)).toEqual(expected);
      expect(await store.getSettings(companyId)).toEqual(expected);
      expect(await store.getSettings(otherCompanyId)).toEqual(control);
    }
  });

  it("uses defaults for omitted fields on the first partial insert", async () => {
    expect(await store.getSettings(firstInsertCompanyId)).toEqual(CORPUS_DEFAULT_SETTINGS);
    const expected = { ...CORPUS_DEFAULT_SETTINGS, enabled: true, defaultParserUrl: "https://first.example" };
    expect(await store.updateSettings(firstInsertCompanyId, {
      enabled: true,
      defaultParserUrl: "https://first.example",
      defaultEmbeddingModel: undefined,
    })).toEqual(expected);
    expect(await store.getSettings(firstInsertCompanyId)).toEqual(expected);
  });
});
