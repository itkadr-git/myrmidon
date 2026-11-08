import http from "node:http";
import type { AddressInfo } from "node:net";
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
  type Db,
  type EmbeddedPostgresTestDatabase,
} from "@myrmidon/db";
import { installPgvectorIntoEmbeddedCluster } from "@myrmidon/corpus";
import { configureCorpusAdapters, resolveCorpusPorts, createCorpusParseWorker, corpusService } from "./index.js";
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
      parserMaxRunMs: 6 * 60 * 60 * 1000,
      parserQueueTimeoutMs: 4 * 60 * 60 * 1000,
      embedderModel: "corpus-embed-pplx-0.6b",
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
      parserMaxRunMs: 6 * 60 * 60 * 1000,
      parserQueueTimeoutMs: 4 * 60 * 60 * 1000,
      embedderModel: "corpus-embed-pplx-0.6b",
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
    const settings: CorpusPortContext["settings"] = {
      enabled: true,
      parserBaseUrl: "http://parser.invalid",
      parserTimeoutMs: 1000,
      parserMaxRunMs: 6 * 60 * 60 * 1000,
      parserQueueTimeoutMs: 4 * 60 * 60 * 1000,
      embedderModel: "corpus-embed-pplx-0.6b",
      embedderDimensions: 3,
      embedderBaseUrl: null,
      maxDocumentBytes: 1024,
      maxDocumentsPerDataset: 5,
      parseConcurrency: 1,
      maxParseAttempts: 2,
      searchTopK: 5,
    };
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
      parserMaxRunMs: 6 * 60 * 60 * 1000, parserQueueTimeoutMs: 4 * 60 * 60 * 1000,
      embedderModel: "corpus-embed-pplx-0.6b", embedderDimensions: 3, embedderBaseUrl: null,
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

  it("parses a failed document again through the real adapters: same job, attempts cleared", async () => {
    const db = createDb(database!.connectionString);
    const companyId = randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'reparse-test', 'RPT')`);
    await db.execute(sql`delete from corpus_parse_jobs where company_id <> ${companyId}`);
    const settings: CorpusPortContext["settings"] = {
      enabled: true, parserBaseUrl: "http://parser.invalid", parserTimeoutMs: 1000,
      parserMaxRunMs: 6 * 60 * 60 * 1000, parserQueueTimeoutMs: 4 * 60 * 60 * 1000,
      embedderModel: "corpus-embed-pplx-0.6b", embedderDimensions: 3, embedderBaseUrl: "http://embedder.invalid",
      maxDocumentBytes: 1024, maxDocumentsPerDataset: 5, parseConcurrency: 1,
      maxParseAttempts: 1, searchTopK: 5,
    };
    const ports = createCorpusPorts(db, { env: {}, settings }, { storageLocalDiskBaseDir: storageDir! } as Config);
    const dataset = await ports.store.createDataset({ companyId, name: "reparse dataset", description: null });
    const document = await ports.store.createDocument({ companyId, datasetId: dataset.id, filename: "book.pdf", mimeType: "application/pdf", byteSize: 4, blobRef: "", maxAttempts: 1 });
    const blob = await ports.blobs.put({ companyId, documentId: document.id, filename: document.filename, mimeType: document.mimeType, bytes: new TextEncoder().encode("book") });
    await ports.store.updateDocument(companyId, document.id, { blobRef: blob.ref });
    const enqueued = await ports.queue.enqueue({ companyId, datasetId: dataset.id, documentId: document.id, maxAttempts: 1 });
    // The one attempt runs out: the job and the document are failed, as the sweep leaves them.
    const [claimed] = await ports.queue.claim({ limit: 1 });
    expect(claimed?.id).toBe(enqueued.id);
    await ports.store.updateDocument(companyId, document.id, { status: "parsing" });
    expect((await ports.queue.fail(companyId, enqueued.id, "parser timed out"))?.state).toBe("failed");
    await ports.store.updateDocument(companyId, document.id, { status: "failed", error: "parser timed out" });
    expect(await ports.store.getDocument(companyId, document.id)).toMatchObject({ status: "failed", attempts: 1 });

    const audit: unknown[] = [];
    const service = corpusService({} as Db, {
      settings: { getGeneral: async () => ({ corpus: settings }), updateGeneral: async () => ({}) },
      listCompanyIds: async () => [companyId],
      logActivity: async (entry) => { audit.push(entry); },
      ports: () => ports,
      env: {},
    });
    const actor = { actorType: "user", actorId: "user-a", agentId: null, runId: null, agentApiKeyId: null } as const;

    const result = await service.reparseDocument(companyId, document.id, actor);

    expect(result.document).toMatchObject({ id: document.id, status: "queued", error: null, attempts: 0 });
    expect(result.job).toMatchObject({ id: enqueued.id, state: "queued", attempts: 0, lastError: null });
    const rows = await db.execute(sql`
      select id, status, attempts, last_error, finished_at from corpus_parse_jobs where document_id = ${document.id}
    `) as unknown as Array<{ id: string; status: string; attempts: number; last_error: string | null; finished_at: Date | null }>;
    expect(rows).toEqual([{ id: enqueued.id, status: "pending", attempts: 0, last_error: null, finished_at: null }]);
    expect(audit).toHaveLength(1);
    // The sweep takes it again, from the bytes that were stored.
    const [again] = await ports.queue.claim({ limit: 1 });
    expect(again).toMatchObject({ id: enqueued.id, attempts: 1 });
    expect(new TextDecoder().decode(await ports.blobs.get(blob.ref))).toBe("book");
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

  it("MCP corpus_search cites document.name as the filename, not the UUID (OPE-12028)", async () => {
    const captured: { calls: number } = { calls: 0 };
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/embeddings") {
        captured.calls += 1;
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          const body = JSON.parse(raw) as { input?: string[] };
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            data: (body.input ?? []).map((_, index) => ({
              index,
              embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
            })),
          }));
        });
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const dbInstance = createDb(database!.connectionString);
      const companyId = randomUUID();
      await dbInstance.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'mcp-name-test', 'MCN')`);

      const settings: CorpusPortContext["settings"] = {
        enabled: true,
        parserBaseUrl: "http://parser.invalid",
        parserTimeoutMs: 1000,
      parserMaxRunMs: 6 * 60 * 60 * 1000,
      parserQueueTimeoutMs: 4 * 60 * 60 * 1000,
        embedderModel: "corpus-embed-pplx-0.6b",
        embedderDimensions: 1024,
        embedderBaseUrl: baseUrl,
        maxDocumentBytes: 1024,
        maxDocumentsPerDataset: 5,
        parseConcurrency: 1,
        maxParseAttempts: 2,
        searchTopK: 5,
      };

      const ports = createCorpusPorts(dbInstance, { env: {}, settings }, { storageLocalDiskBaseDir: storageDir! } as Config);
      const dataset = await ports.store.createDataset({ companyId, name: "bbq-craft", description: null });
      const document = await ports.store.createDocument({
        companyId,
        datasetId: dataset.id,
        filename: "Weber_book.pdf",
        mimeType: "application/pdf",
        byteSize: 100,
        blobRef: "",
        maxAttempts: 2,
      });
      await ports.index.indexDocument({
        companyId,
        datasetId: dataset.id,
        documentId: document.id,
        chunks: [{ text: "weber grill temperature guide", index: 0 }],
        embedderModel: settings.embedderModel,
        embedderDimensions: settings.embedderDimensions,
        embedderBaseUrl: baseUrl,
      });
      // Search only returns chunks of `ready` documents; drive the status to
      // `ready` through the port: updateDocument internally walks the store
      // chain parsing -> embedding -> ready when it sees a parsing -> ready jump.
      await ports.store.updateDocument(companyId, document.id, { status: "parsing" });
      await ports.store.updateDocument(companyId, document.id, { status: "ready" });

      const { createCorpusMcpProvider } = await import("./adapters.js");
      const provider = createCorpusMcpProvider(
        async () => settings,
        (context) => createCorpusPorts(dbInstance, context, { storageLocalDiskBaseDir: storageDir! } as Config),
      );
      const tools = await provider(companyId);
      expect(tools).not.toBeNull();

      const result = await tools!.search({
        query: "weber grill",
        datasets: [],
        topK: 5,
        minScore: null,
      });

      expect(result.hits.length).toBeGreaterThan(0);
      const hit = result.hits.find((h) => h.document.id === document.id);
      expect(hit).toBeDefined();
      // The bug: document.name was the UUID. The fix: it is the uploaded filename.
      expect(hit!.document.name).toBe("Weber_book.pdf");
      expect(hit!.document.name).not.toBe(document.id);

      // corpus_get_document with include_text=true must not crash on empty blobRef.
      const view = await tools!.getDocument({ documentId: document.id, includeText: true });
      expect(view.document.name).toBe("Weber_book.pdf");
      expect(view.text).toBeNull();

      await dbInstance.$client.end();
    } finally {
      server.close();
    }
  });

  it("indexes document chunks by calling the embeddings endpoint with corpus-embed-pplx-0.6b", async () => {
    const captured: { body: { model?: string; input?: string[]; dimensions?: number } | null; calls: number } = { body: null, calls: 0 };
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/embeddings") {
        captured.calls += 1;
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          captured.body = JSON.parse(raw);
          const input = captured.body?.input ?? [];
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            data: input.map((_, index) => ({
              index,
              embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
            })),
          }));
        });
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const dbInstance = createDb(database!.connectionString);
      const companyId = randomUUID();
      await dbInstance.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'bge-test', 'BGE')`);

      const settings: CorpusPortContext["settings"] = {
        enabled: true,
        parserBaseUrl: "http://parser.invalid",
        parserTimeoutMs: 1000,
      parserMaxRunMs: 6 * 60 * 60 * 1000,
      parserQueueTimeoutMs: 4 * 60 * 60 * 1000,
        embedderModel: "corpus-embed-pplx-0.6b",
        embedderDimensions: 1024,
        embedderBaseUrl: baseUrl,
        maxDocumentBytes: 1024,
        maxDocumentsPerDataset: 5,
        parseConcurrency: 1,
        maxParseAttempts: 2,
        searchTopK: 5,
      };

      const ports = createCorpusPorts(dbInstance, { env: {}, settings }, { storageLocalDiskBaseDir: storageDir! } as Config);
      const dataset = await ports.store.createDataset({ companyId, name: "bge dataset", description: null });
      const document = await ports.store.createDocument({
        companyId,
        datasetId: dataset.id,
        filename: "test.txt",
        mimeType: "text/plain",
        byteSize: 10,
        blobRef: "b1",
        maxAttempts: 2,
      });

      const indexedCount = await ports.index.indexDocument({
        companyId,
        datasetId: dataset.id,
        documentId: document.id,
        chunks: [{ text: "hello bge-m3 world", index: 0 }],
        embedderModel: settings.embedderModel,
        embedderDimensions: settings.embedderDimensions,
        embedderBaseUrl: baseUrl,
      });

      expect(indexedCount).toBe(1);
      expect(captured.body).not.toBeNull();
      expect(captured.body?.model).toBe("corpus-embed-pplx-0.6b");
      expect(captured.body?.input).toEqual(["hello bge-m3 world"]);
      expect(captured.body?.dimensions).toBe(1024);

      const search = { companyId, datasetId: dataset.id, query: "hello bge-m3 world", limit: 5, mode: "hybrid" as const, embedderModel: settings.embedderModel, embedderDimensions: settings.embedderDimensions, embedderBaseUrl: baseUrl };
      const secondPorts = createCorpusPorts(dbInstance, { env: {}, settings }, { storageLocalDiskBaseDir: storageDir! } as Config);
      await Promise.all([ports.index.search(search), secondPorts.index.search(search)]);
      await secondPorts.index.search(search);
      expect(captured.calls).toBe(2); // one ingestion request, one shared query embedding

      await dbInstance.$client.end();
    } finally {
      server.close();
    }
  });

  // myrmidon(1.6.6 OPE-12000): the SQL of the URL-source bookkeeping, against a real database.
  it("keeps the address and fetch bookkeeping of a URL source and lists only the documents that are due", async () => {
    const db = createDb(database!.connectionString);
    const companyId = randomUUID();
    await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, 'url-source', 'URS')`);
    const settings: CorpusPortContext["settings"] = {
      enabled: true,
      parserBaseUrl: "http://parser.invalid",
      parserTimeoutMs: 1000,
      parserMaxRunMs: 6 * 60 * 60 * 1000,
      parserQueueTimeoutMs: 4 * 60 * 60 * 1000,
      embedderModel: "corpus-embed-pplx-0.6b",
      embedderDimensions: 3,
      embedderBaseUrl: null,
      maxDocumentBytes: 1024,
      maxDocumentsPerDataset: 10,
      parseConcurrency: 1,
      maxParseAttempts: 2,
      searchTopK: 5,
    };
    const ports = createCorpusPorts(db, { env: {}, settings }, { storageLocalDiskBaseDir: storageDir! } as Config);
    const dataset = await ports.store.createDataset({ companyId, name: "urls", description: null });
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const base = { companyId, datasetId: dataset.id, mimeType: "text/html", byteSize: 5, blobRef: "b", maxAttempts: 2 };
    const daily = await ports.store.createDocument({
      ...base,
      filename: "daily.html",
      source: { url: "https://docs.example.com/a", refreshIntervalHours: 24, contentHash: "h1", fetchedAt: twoDaysAgo },
    });
    const weekly = await ports.store.createDocument({
      ...base,
      filename: "weekly.html",
      source: { url: "https://docs.example.com/b", refreshIntervalHours: 168, contentHash: "h2", fetchedAt: twoDaysAgo },
    });
    const upload = await ports.store.createDocument({ ...base, filename: "upload.txt" });
    // The RAGFlow importer keeps its provenance in the same column; it must not look like a URL source.
    await db.execute(sql`update corpus_documents set source_uri = 'http://ragflow:9380/api/v1/datasets/x/documents/y' where id = ${upload.id}`);

    expect(daily).toMatchObject({
      sourceUrl: "https://docs.example.com/a",
      refreshIntervalHours: 24,
      contentHash: "h1",
      lastFetchedAt: twoDaysAgo,
      sourceError: null,
    });
    expect((await ports.store.getDocument(companyId, upload.id))?.sourceUrl).toBeNull();

    const due = await ports.store.listSourceDocuments({ companyId, dueAt: new Date(), limit: 10 });
    expect(due.map((document) => document.id)).toEqual([daily.id]);
    expect(due[0]).toMatchObject({ sourceUrl: "https://docs.example.com/a", blobRef: "b", status: "queued" });
    const everything = await ports.store.listSourceDocuments({ companyId, datasetId: dataset.id, limit: 10 });
    expect(everything.map((document) => document.id).sort()).toEqual([daily.id, weekly.id].sort());
    expect(await ports.store.listSourceDocuments({ companyId: randomUUID(), limit: 10 })).toEqual([]);

    // The bookkeeping is merged into `metadata`: the interval survives, the rest moves.
    const fetchedAt = new Date().toISOString();
    const updated = await ports.store.updateDocument(companyId, daily.id, {
      lastFetchedAt: fetchedAt,
      sourceError: "boom",
      contentHash: "h3",
      byteSize: 77,
      mimeType: "text/plain",
    });
    expect(updated).toMatchObject({
      refreshIntervalHours: 24,
      lastFetchedAt: fetchedAt,
      sourceError: "boom",
      contentHash: "h3",
      byteSize: 77,
      mimeType: "text/plain",
    });
    expect(await ports.store.listSourceDocuments({ companyId, dueAt: new Date(), limit: 10 })).toEqual([]);
    // ...and it is due again once the interval has passed.
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect((await ports.store.listSourceDocuments({ companyId, dueAt: later, limit: 10 })).map((document) => document.id)).toEqual([daily.id]);

    // The bytes a refresh replaced are remembered until the new version is ready, then forgotten; the
    // bookkeeping around them is merged, not replaced.
    expect((await ports.store.updateDocument(companyId, daily.id, { previousBlobRef: "old-blob" }))?.previousBlobRef).toBe("old-blob");
    const touched = await ports.store.updateDocument(companyId, daily.id, { lastFetchedAt: new Date().toISOString() });
    expect(touched).toMatchObject({ previousBlobRef: "old-blob", refreshIntervalHours: 24 });
    expect((await ports.store.updateDocument(companyId, daily.id, { previousBlobRef: null }))?.previousBlobRef).toBeNull();

    // A parsed document goes back to `queued` with its parse state cleared, the way a refresh does it.
    await ports.store.updateDocument(companyId, daily.id, { status: "parsing" });
    await ports.store.updateDocument(companyId, daily.id, { status: "ready", chunkCount: 0, error: null, parsedAt: new Date().toISOString() });
    expect((await ports.store.getDocument(companyId, daily.id))?.parsedAt).not.toBeNull();
    const requeued = await ports.store.updateDocument(companyId, daily.id, { status: "queued", error: null, attempts: 0, parsedAt: null });
    expect(requeued).toMatchObject({ status: "queued", parsedAt: null, refreshIntervalHours: 24, sourceUrl: "https://docs.example.com/a" });
    await db.$client.end();
  });
});
