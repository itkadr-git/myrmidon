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
} from "@paperclipai/db";
import { installPgvectorIntoEmbeddedCluster } from "@paperclipai/corpus";
import { configureCorpusAdapters, resolveCorpusPorts, createCorpusParseWorker } from "./index.js";
import { createCorpusPorts } from "./adapters.js";
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
});
