import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@myrmidon/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";

describe("document roundtrip on embedded Postgres", () => {
  let testDb: EmbeddedPostgresTestDatabase | undefined;
  let pgvector: PgvectorInstall | undefined;
  let store: PostgresCorpusStore;
  let companyId: string;
  let otherCompanyId: string;
  let datasetId: string;

  beforeAll(async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) throw new Error(support.reason ?? "embedded Postgres unsupported");
    pgvector = await installPgvectorIntoEmbeddedCluster();
    if (!pgvector.ok) throw new Error(pgvector.reason);
    testDb = await startEmbeddedPostgresTestDatabase("corpus-roundtrip-");
    const db = createDb(testDb.connectionString);
    store = new PostgresCorpusStore(db);
    companyId = crypto.randomUUID();
    otherCompanyId = crypto.randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values
      (${companyId}, 'roundtrip', 'RT'), (${otherCompanyId}, 'other', 'OT')`);
    datasetId = (await store.createDataset({ companyId, name: "roundtrip" })).id;
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb?.cleanup();
    } finally {
      await pgvector?.cleanup();
    }
  });

  const cases = [
    {
      name: "minimal input",
      input: { title: "minimal.txt" },
      expected: { sourceUri: null, blobKey: null, contentType: null, byteSize: null, contentHash: null, metadata: {} },
    },
    {
      name: "explicit nulls",
      input: { title: "nulls.txt", sourceUri: null, blobKey: null, contentType: null, byteSize: null, contentHash: null, metadata: {} },
      expected: { sourceUri: null, blobKey: null, contentType: null, byteSize: null, contentHash: null, metadata: {} },
    },
    {
      name: "full input including zero size and nested metadata",
      input: {
        title: "complete.pdf", sourceUri: "https://example.org/spec.pdf", blobKey: "docs/spec.pdf",
        contentType: "application/pdf", byteSize: 0, contentHash: "sha256:abc123",
        metadata: { nested: { tags: ["one", "two"], empty: null }, enabled: false, count: 0 },
      },
      expected: {
        sourceUri: "https://example.org/spec.pdf", blobKey: "docs/spec.pdf", contentType: "application/pdf",
        byteSize: 0, contentHash: "sha256:abc123",
        metadata: { nested: { tags: ["one", "two"], empty: null }, enabled: false, count: 0 },
      },
    },
    {
      name: "nonzero size",
      input: { title: "bytes.txt", byteSize: 12345 },
      expected: { sourceUri: null, blobKey: null, contentType: null, byteSize: 12345, contentHash: null, metadata: {} },
    },
  ];

  it.each(cases)("preserves $name through create, read and raw row", async ({ input, expected }) => {
    const created = await store.createDocument({ companyId, datasetId, ...input });
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect(created).toEqual({
      id: created.id, companyId, datasetId, title: input.title, ...expected,
      status: "queued", parseError: null, parserVersion: null, parsedAt: null,
      createdAt: created.createdAt, updatedAt: created.updatedAt,
    });
    expect(await store.getDocument(companyId, created.id)).toEqual(created);

    const db = createDb(testDb!.connectionString);
    const rows = await db.execute(sql`select id, company_id as "companyId", dataset_id as "datasetId",
      title, source_uri as "sourceUri", blob_key as "blobKey", content_type as "contentType",
      byte_size::int as "byteSize", content_hash as "contentHash", metadata, status,
      parse_error as "parseError", parser_version as "parserVersion", parsed_at as "parsedAt",
      created_at as "createdAt", updated_at as "updatedAt"
      from corpus_documents where id = ${created.id}`);
    expect(rows).toHaveLength(1);
    const row = rows[0] as typeof created & { createdAt: unknown; updatedAt: unknown };
    expect({ ...row, createdAt: new Date(String(row.createdAt)), updatedAt: new Date(String(row.updatedAt)) }).toEqual(created);
  });

  it("does not reveal another company's document or a missing UUID", async () => {
    const created = await store.createDocument({ companyId, datasetId, title: "private.txt" });
    expect(await store.getDocument(otherCompanyId, created.id)).toBeNull();
    expect(await store.getDocument(companyId, crypto.randomUUID())).toBeNull();
    expect(await store.getDocument(companyId, created.id)).toEqual(created);
  });
});
