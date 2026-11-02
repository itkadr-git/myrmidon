import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  applyPendingMigrations,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@myrmidon/db";
import { installPgvectorIntoEmbeddedCluster } from "@myrmidon/corpus";
import { configureCorpusAdapters, resolveCorpusPorts, createCorpusParseWorker } from "./index.js";
import { createCorpusPorts, createSqlExecutor } from "./adapters.js";
import type { CorpusPortContext } from "./ports.js";
import type { Config } from "../../config.js";

const support = await getEmbeddedPostgresTestSupport();
const pgvector = support.supported
  ? await installPgvectorIntoEmbeddedCluster()
  : { ok: false, reason: support.reason ?? "embedded PostgreSQL is unsupported", cleanup: async () => {} };
const run = support.supported && pgvector.ok ? describe : describe.skip;

if (!support.supported || !pgvector.ok) {
  console.warn(`[corpus] production adapter test skipped: ${pgvector.reason ?? support.reason}`);
}

afterAll(async () => {
  await pgvector.cleanup();
});

run("production corpus adapters", () => {
  let database: EmbeddedPostgresTestDatabase | undefined;
  let storageDir: string | undefined;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("server-corpus-adapters-");
    await applyPendingMigrations(database.connectionString);
    const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? os.homedir();
    storageDir = await mkdtemp(path.join(scratchRoot, "server-corpus-adapters-files-"));
  }, 120_000);

  afterAll(async () => {
    await rm(storageDir ?? "", { recursive: true, force: true });
    await database?.cleanup();
    await pgvector.cleanup();
  });

  it("persists blob references and enqueues through the real PostgreSQL adapters", async () => {
    const db = createDb(database!.connectionString);
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const thirdCompanyId = randomUUID();
    await db.execute(sql`
      insert into companies (id, name, issue_prefix) values
        (${companyId}, 'adapter-test', 'CAT'),
        (${otherCompanyId}, 'adapter-other', 'CAO'),
        (${thirdCompanyId}, 'adapter-third', 'CAX')
    `);
    const settings: CorpusPortContext["settings"] = {
      enabled: true,
      parserBaseUrl: "http://parser.invalid",
      parserTimeoutMs: 1000,
      embedderModel: "test",
      embedderDimensions: 3,
      embedderBaseUrl: null,
      maxDocumentBytes: 1024,
      maxDocumentsPerDataset: 5,
      parseConcurrency: 1,
      maxParseAttempts: 2,
      searchTopK: 5,
    };
    const config = { storageLocalDiskBaseDir: storageDir! } as Config;
    const ports = createCorpusPorts(db, {
      env: {},
      settings,
    }, config);
    const dataset = await ports.store.createDataset({ companyId, name: "adapter dataset", description: null });
    const document = await ports.store.createDocument({
      companyId,
      datasetId: dataset.id,
      filename: "hello.txt",
      mimeType: "text/plain",
      byteSize: 5,
      blobRef: "",
      maxAttempts: 2,
    });
    const blob = await ports.blobs.put({ companyId, documentId: document.id, filename: "hello.txt", mimeType: "text/plain", bytes: Buffer.from("hello") });
    const updated = await ports.store.updateDocument(companyId, document.id, { blobRef: blob.ref });
    expect(updated?.blobRef).toBe(blob.ref);
    expect(await ports.blobs.get(blob.ref)).toEqual(new Uint8Array(Buffer.from("hello")));

    const job = await ports.queue.enqueue({ companyId, datasetId: dataset.id, documentId: document.id, maxAttempts: 2 });
    expect(job.state).toBe("queued");
    expect((await ports.store.listDocuments(otherCompanyId, dataset.id)).length).toBe(0);
    const otherPorts = createCorpusPorts(db, { env: {}, settings }, config);
    const otherDataset = await otherPorts.store.createDataset({ companyId: otherCompanyId, name: "other", description: null });
    const otherDocument = await otherPorts.store.createDocument({ companyId: otherCompanyId, datasetId: otherDataset.id, filename: "other.txt", mimeType: "text/plain", byteSize: 5, blobRef: "other", maxAttempts: 2 });
    await otherPorts.queue.enqueue({ companyId: otherCompanyId, datasetId: otherDataset.id, documentId: otherDocument.id, maxAttempts: 2 });
    const thirdDataset = await ports.store.createDataset({ companyId: thirdCompanyId, name: "third", description: null });
    const thirdDocument = await ports.store.createDocument({ companyId: thirdCompanyId, datasetId: thirdDataset.id, filename: "third.txt", mimeType: "text/plain", byteSize: 5, blobRef: "third", maxAttempts: 2 });
    await ports.queue.enqueue({ companyId: thirdCompanyId, datasetId: thirdDataset.id, documentId: thirdDocument.id, maxAttempts: 2 });
    const claimed = await ports.queue.claim({ limit: 2 });
    expect(claimed).toHaveLength(2);
    expect(claimed.map((entry) => entry.companyId)).toEqual(expect.arrayContaining([companyId, otherCompanyId]));
    const thirdClaimed = await ports.queue.claim({ limit: 2 });
    expect(thirdClaimed.map((entry) => entry.companyId)).toContain(thirdCompanyId);
    // Fairness: two pending jobs of one company plus one of another, limit 2 -> one per company, exactly 2 rows.
    for (let i = 0; i < 2; i += 1) {
      const doc = await ports.store.createDocument({ companyId, datasetId: dataset.id, filename: `a${i}.txt`, mimeType: "text/plain", byteSize: 5, blobRef: `a${i}`, maxAttempts: 2 });
      await ports.queue.enqueue({ companyId, datasetId: dataset.id, documentId: doc.id, maxAttempts: 2 });
    }
    const otherDoc2 = await otherPorts.store.createDocument({ companyId: otherCompanyId, datasetId: otherDataset.id, filename: "b.txt", mimeType: "text/plain", byteSize: 5, blobRef: "b", maxAttempts: 2 });
    await otherPorts.queue.enqueue({ companyId: otherCompanyId, datasetId: otherDataset.id, documentId: otherDoc2.id, maxAttempts: 2 });
    const fair = await ports.queue.claim({ limit: 2 });
    expect(fair).toHaveLength(2);
    expect(new Set(fair.map((entry) => entry.companyId))).toEqual(new Set([companyId, otherCompanyId]));
    const first = claimed[0]!;
    const released = await ports.queue.fail(first.companyId, first.id, "temporary parser error");
    expect(released?.state).toBe("queued");
    expect(released?.attempts).toBe(1);
    await db.$client.end();
  });

  it("resolves ports when enabled and returns null when disabled (no-op)", async () => {
    const settings: CorpusPortContext["settings"] = {
      enabled: false,
      parserBaseUrl: "http://parser.invalid",
      parserTimeoutMs: 1000,
      embedderModel: "test",
      embedderDimensions: 3,
      embedderBaseUrl: null,
      maxDocumentBytes: 1024,
      maxDocumentsPerDataset: 5,
      parseConcurrency: 1,
      maxParseAttempts: 2,
      searchTopK: 5,
    };
    expect(resolveCorpusPorts({ env: {}, settings })).toBeNull();

    const db = createDb(database!.connectionString);
    const config = { storageLocalDiskBaseDir: storageDir! } as Config;
    configureCorpusAdapters(db, config);

    expect(resolveCorpusPorts({ env: {}, settings: { ...settings, enabled: false } })).toBeNull();
    const resolved = resolveCorpusPorts({ env: {}, settings: { ...settings, enabled: true } });
    expect(resolved).not.toBeNull();
    expect(resolved?.store).toBeDefined();
    expect(resolved?.queue).toBeDefined();
    expect(resolved?.blobs).toBeDefined();
    expect(resolved?.index).toBeDefined();
    await db.$client.end();
  });

  it("exposes datasets created after an MCP provider is constructed", async () => {
    const db = createDb(database!.connectionString);
    const companyId = randomUUID();
    await db.execute(sql`
      insert into companies (id, name, issue_prefix) values
        (${companyId}, 'mcp-refresh', 'MCP')
    `);
    const settings: CorpusPortContext["settings"] = { enabled: true, parserBaseUrl: "http://parser.invalid", parserTimeoutMs: 1000, embedderModel: "test", embedderDimensions: 3, embedderBaseUrl: null, maxDocumentBytes: 1024, maxDocumentsPerDataset: 5, parseConcurrency: 1, maxParseAttempts: 2, searchTopK: 5 };
    const { createCorpusMcpProvider } = await import("./adapters.js");
    const provider = createCorpusMcpProvider(async () => settings, (context) => createCorpusPorts(db, context, { storageLocalDiskBaseDir: storageDir! } as Config));
    const tools = await provider(companyId);
    expect(tools).not.toBeNull();
    const created = await createCorpusPorts(db, { env: {}, settings }, { storageLocalDiskBaseDir: storageDir! } as Config).store.createDataset({ companyId, name: "after registration", description: null });
    expect((await tools!.listDatasets()).map((dataset) => dataset.id)).toContain(created.id);
    await createCorpusPorts(db, { env: {}, settings }, { storageLocalDiskBaseDir: storageDir! } as Config).store.updateDataset(companyId, created.id, { name: "renamed" });
    expect((await tools!.listDatasets()).find((dataset) => dataset.id === created.id)?.name).toBe("renamed");
    await db.$client.end();
  });

  it("runs parser failure through queue retry and reclaims the due job", async () => {
    const db = createDb(database!.connectionString);
    const companyId = randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'retry-test', 'RET')`);
    // The sweep claims across companies, and the first test of this file leaves due jobs of its own
    // companies behind; drop them so every claim below is the job of this test.
    await db.execute(sql`delete from corpus_parse_jobs where company_id <> ${companyId}`);
    const settings: CorpusPortContext["settings"] = {
      enabled: true, parserBaseUrl: "http://parser.invalid", parserTimeoutMs: 1000,
      embedderModel: "test", embedderDimensions: 3, embedderBaseUrl: null,
      maxDocumentBytes: 1024, maxDocumentsPerDataset: 5, parseConcurrency: 1,
      maxParseAttempts: 2, searchTopK: 5,
    };
    const ports = createCorpusPorts(db, { env: {}, settings }, { storageLocalDiskBaseDir: storageDir! } as Config);
    const dataset = await ports.store.createDataset({ companyId, name: "retry dataset", description: null });
    const document = await ports.store.createDocument({ companyId, datasetId: dataset.id, filename: "retry.txt", mimeType: "text/plain", byteSize: 4, blobRef: "", maxAttempts: 2 });
    const blob = await ports.blobs.put({ companyId, documentId: document.id, filename: document.filename, mimeType: document.mimeType, bytes: new TextEncoder().encode("test") });
    await ports.store.updateDocument(companyId, document.id, { blobRef: blob.ref });
    await ports.queue.enqueue({ companyId, datasetId: dataset.id, documentId: document.id, maxAttempts: 2 });
    const worker = createCorpusParseWorker({
      ports: (context) => createCorpusPorts(db, context, { storageLocalDiskBaseDir: storageDir! } as Config),
      resolveSettings: async () => ({ settings, enabled: true }),
      env: {},
    });

    const first = await worker.sweep();
    expect(first.requeued).toBe(1);
    expect((await ports.store.getDocument(companyId, document.id))?.status).toBe("queued");
    const retryRows = await db.execute(sql`
      select id from corpus_parse_jobs
      where company_id = ${companyId} and document_id = ${document.id}
      order by created_at desc
      limit 1
    `) as unknown as Array<{ id: string }>;
    const retryJobId = retryRows[0]?.id;
    expect(retryJobId).toBeDefined();
    // Not claimable before the backoff: the pass sees nothing to do.
    await db.execute(sql`update corpus_parse_jobs set next_attempt_at = now() + interval '1 hour' where id = ${retryJobId!}`);
    expect((await worker.sweep()).claimed).toBe(0);
    await db.execute(sql`update corpus_parse_jobs set next_attempt_at = now() where id = ${retryJobId!}`);
    const second = await worker.sweep();
    expect(second.claimed).toBe(1);
    expect(second.failed).toBe(1);
    const final = await ports.store.getJob(companyId, retryJobId!);
    expect(final?.state).toBe("failed");
    expect(final?.attempts).toBe(2);
    expect(final?.maxAttempts).toBe(2);
    const failedDocument = await ports.store.getDocument(companyId, document.id);
    expect(failedDocument?.status).toBe("failed");
    expect(failedDocument?.error).toBeTruthy();
    await db.$client.end();
  });

  it("rolls back multi-step writes atomically in withTransaction when an error occurs on real PostgreSQL", async () => {
    const db = createDb(database!.connectionString);
    const sqlExecutor = createSqlExecutor(db);
    const companyId = randomUUID();
    const datasetId = randomUUID();
    const documentId = randomUUID();
    await db.execute(sql`
      insert into companies (id, name, issue_prefix) values (${companyId}, 'tx-test', 'CTX')
    `);
    await db.execute(sql`
      insert into corpus_datasets (id, company_id, name) values (${datasetId}, ${companyId}, 'tx-dataset')
    `);

    // Multi-step write (document + job) where failure midway aborts the transaction
    await expect(
      sqlExecutor.withTransaction(async (tx) => {
        await tx.query(
          `insert into corpus_documents (id, company_id, dataset_id, title, status, source_uri)
           values ($1, $2, $3, $4, $5, $6)`,
          [documentId, companyId, datasetId, "Mid-failure Doc", "queued", "source://test"],
        );

        // Verify document is temporarily visible inside the uncommitted transaction
        const inTx = await tx.query<{ id: string }>(
          `select id from corpus_documents where id = $1`,
          [documentId],
        );
        expect(inTx).toHaveLength(1);

        // Mid-step failure
        throw new Error("simulated mid-write failure");
      }),
    ).rejects.toThrow("simulated mid-write failure");

    // Outside the aborted transaction: no partial data must remain
    const documentsAfterRollback = await sqlExecutor.query<{ id: string }>(
      `select id from corpus_documents where id = $1`,
      [documentId],
    );
    expect(documentsAfterRollback).toEqual([]);

    // Verify SET LOCAL works inside withTransaction (Alex's review note on PR #1339)
    await sqlExecutor.withTransaction(async (tx) => {
      await tx.query("set local hnsw.ef_search = 120");
      const ef = await tx.query<{ ef_search: string }>("select current_setting('hnsw.ef_search', true) as ef_search");
      expect(ef[0]?.ef_search).toBe("120");
    });

    // Verify successful multi-step writes commit atomically
    const committedDocId = randomUUID();
    const committedJobId = randomUUID();
    await sqlExecutor.withTransaction(async (tx) => {
      await tx.query(
        `insert into corpus_documents (id, company_id, dataset_id, title, status, source_uri)
         values ($1, $2, $3, $4, $5, $6)`,
        [committedDocId, companyId, datasetId, "Committed Doc", "queued", "source://test"],
      );
      await tx.query(
        `insert into corpus_parse_jobs (id, company_id, document_id, parser_version, status, attempts, max_attempts)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [committedJobId, companyId, committedDocId, "v1", "pending", 0, 3],
      );
    });

    const docs = await sqlExecutor.query<{ id: string; title: string }>(
      `select id, title from corpus_documents where id = $1`,
      [committedDocId],
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toBe("Committed Doc");

    const jobs = await sqlExecutor.query<{ id: string; document_id: string }>(
      `select id, document_id from corpus_parse_jobs where id = $1`,
      [committedJobId],
    );
    expect(jobs).toHaveLength(1);

    // Verify nested withTransaction creates a real savepoint that rolls back independently
    const outerDocId = randomUUID();
    const nestedAbortedDocId = randomUUID();
    await sqlExecutor.withTransaction(async (outerTx) => {
      await outerTx.query(
        `insert into corpus_documents (id, company_id, dataset_id, title, status, source_uri)
         values ($1, $2, $3, $4, $5, $6)`,
        [outerDocId, companyId, datasetId, "Outer Doc", "queued", "source://outer"],
      );
      try {
        await outerTx.withTransaction(async (innerTx) => {
          await innerTx.query(
            `insert into corpus_documents (id, company_id, dataset_id, title, status, source_uri)
             values ($1, $2, $3, $4, $5, $6)`,
            [nestedAbortedDocId, companyId, datasetId, "Nested Aborted Doc", "queued", "source://inner"],
          );
          throw new Error("nested abort");
        });
      } catch (err) {
        expect((err as Error).message).toBe("nested abort");
      }
    });

    const outerDocs = await sqlExecutor.query<{ id: string }>(
      `select id from corpus_documents where id = $1`,
      [outerDocId],
    );
    expect(outerDocs).toHaveLength(1);

    const nestedDocs = await sqlExecutor.query<{ id: string }>(
      `select id from corpus_documents where id = $1`,
      [nestedAbortedDocId],
    );
    expect(nestedDocs).toEqual([]);

    await db.$client.end();
  });
});
