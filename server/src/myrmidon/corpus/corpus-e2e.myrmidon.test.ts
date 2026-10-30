// server/src/myrmidon/corpus/corpus-e2e.myrmidon.test.ts
//
// myrmidon(1.6.6 CORPUS-2.0, OPE-7844): the whole contour over the production
// adapters — no in-memory port anywhere. A text document goes in through the REST
// upload, the parse sweep claims it from the real queue, the parse service (a
// local HTTP stand-in speaking the real wire contract) returns its text, the
// embeddings endpoint (the same stand-in) vectorizes it, the document becomes
// `ready`, and the same document is found by the REST search and by the MCP
// `corpus_search` tool. Also pinned: `tools/list`, company isolation, a disabled
// module that touches no port, and a parser failure that retries and then fails
// the document.
//
// Needs embedded PostgreSQL with pgvector; skipped (with a warning) where the
// host cannot provide it, exactly like the package tests of part A.

import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  getEmbeddedPostgresTestSupport,
  instanceSettings,
  startEmbeddedPostgresTestDatabase,
  type Db,
  type EmbeddedPostgresTestDatabase,
} from "@myrmidon/db";
import { installPgvectorIntoEmbeddedCluster } from "@myrmidon/corpus";
import { errorHandler } from "../../middleware/index.js";
import type { Config } from "../../config.js";
import {
  configureCorpusAdapters,
  createCorpusParseWorker,
  myrmidonCorpusMcpRoutes,
  resolveCorpusPorts,
} from "./index.js";
import { myrmidonCorpusRoutes } from "./routes.js";
import { corpusService } from "./service.js";

const support = await getEmbeddedPostgresTestSupport();
const pgvector = support.supported
  ? await installPgvectorIntoEmbeddedCluster()
  : { ok: false, reason: support.reason ?? "embedded PostgreSQL is unsupported", cleanup: async () => {} };
const run = support.supported && pgvector.ok ? describe : describe.skip;

if (!support.supported || !pgvector.ok) {
  console.warn(`[corpus] end-to-end test skipped: ${pgvector.reason ?? support.reason}`);
}

const DIMENSIONS = 1024;
const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const TEXT = "The warranty period for the espresso machine is twenty four months from the delivery date.";

const board = (companyId: string) => ({
  type: "board",
  source: "session",
  userId: "user-e2e",
  isInstanceAdmin: true,
  companyIds: [companyId],
});

/** A bag-of-words vector: texts that share words are close in cosine distance. */
function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const digest = createHash("sha256").update(word).digest();
    vector[digest.readUInt16BE(0) % DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

run("corpus end to end over the production adapters", () => {
  let database: EmbeddedPostgresTestDatabase | undefined;
  let db: Db;
  let storageDir: string;
  let standIn: Server;
  let standInUrl: string;
  let parserMode: "ok" | "reject" = "ok";
  const parseSubmissions: string[] = [];
  const parsedTexts = new Map<string, string>();

  async function setCorpusBlock(block: Record<string, unknown>) {
    const rows = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
    const general = { ...(rows[0]?.general ?? {}), corpus: block };
    if (rows.length === 0) await db.insert(instanceSettings).values({ singletonKey: "default", general });
    else await db.update(instanceSettings).set({ general }).where(eq(instanceSettings.singletonKey, "default"));
  }

  const enabledBlock = () => ({
    enabled: true,
    parserBaseUrl: standInUrl,
    parserTimeoutMs: 5000,
    embedderModel: "stand-in",
    embedderDimensions: DIMENSIONS,
    embedderBaseUrl: standInUrl,
    maxParseAttempts: 2,
    parseConcurrency: 2,
  });

  function restApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = board(companyId);
      next();
    });
    app.use("/api", myrmidonCorpusRoutes(db, { ports: resolveCorpusPorts, env: {} }));
    app.use("/api", myrmidonCorpusMcpRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function newWorker() {
    const service = corpusService(db, { ports: resolveCorpusPorts, env: {} });
    return createCorpusParseWorker({
      ports: resolveCorpusPorts,
      resolveSettings: async () => {
        const view = await service.readSettings();
        return { settings: view.settings, enabled: view.enabled };
      },
      env: {},
    });
  }

  beforeAll(async () => {
    standIn = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        res.setHeader("content-type", "application/json");
        if (req.method === "POST" && req.url === "/v1/parse") {
          parseSubmissions.push(String(body.fileName));
          if (parserMode === "reject") {
            res.statusCode = 422;
            res.end(JSON.stringify({ error: "unsupported" }));
            return;
          }
          const text = Buffer.from(String(body.contentBase64), "base64").toString("utf8");
          parsedTexts.set("job-1", text);
          res.end(JSON.stringify({ jobId: "job-1", status: "succeeded", text }));
          return;
        }
        if (req.method === "GET" && req.url?.startsWith("/v1/parse/")) {
          res.end(JSON.stringify({ jobId: "job-1", status: "succeeded", text: parsedTexts.get("job-1") ?? "" }));
          return;
        }
        if (req.method === "POST" && req.url === "/embeddings") {
          const inputs: string[] = Array.isArray(body.input) ? body.input : [String(body.input)];
          res.end(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: embed(text) })) }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
    standInUrl = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;

    database = await startEmbeddedPostgresTestDatabase("server-corpus-e2e-");
    await applyPendingMigrations(database.connectionString);
    db = createDb(database.connectionString);
    const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? os.homedir();
    storageDir = await mkdtemp(path.join(scratchRoot, "server-corpus-e2e-files-"));
    await db.execute(sql`
      insert into companies (id, name, issue_prefix) values
        (${COMPANY}, 'e2e-corpus', 'CE1'),
        (${OTHER_COMPANY}, 'e2e-other', 'CE2')
    `);
    configureCorpusAdapters(db, { storageLocalDiskBaseDir: storageDir } as Config);
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => standIn?.close(() => resolve()));
    await db?.$client.end();
    await rm(storageDir ?? "", { recursive: true, force: true });
    await database?.cleanup();
    await pgvector.cleanup();
  });

  const mcpUrl = (companyId: string) => `/api/myrmidon/companies/${companyId}/corpus/mcp`;
  const restUrl = (companyId: string, rest: string) => `/api/myrmidon/companies/${companyId}/corpus/${rest}`;

  it("is a no-op while the module is disabled: no port, no job, no tools", async () => {
    await setCorpusBlock({ enabled: false });
    const parsedBefore = parseSubmissions.length;
    const worker = newWorker();
    const swept = await worker.sweep();
    expect(swept).toMatchObject({ enabled: false, available: false, claimed: 0 });
    expect(parseSubmissions.length).toBe(parsedBefore);

    const app = restApp(COMPANY);
    await request(app).get(restUrl(COMPANY, "datasets")).expect(503);
    const listed = await request(app).post(mcpUrl(COMPANY)).send({ id: 1, method: "tools/list" }).expect(200);
    expect(listed.body.result.tools).toEqual([]);
  });

  it("takes a text document from upload to a REST and an MCP search hit", async () => {
    await setCorpusBlock(enabledBlock());
    const app = restApp(COMPANY);

    // The module is on and wired: not the corpus_not_configured of the null stub.
    const settings = await request(app).get("/api/myrmidon/corpus/settings").expect(200);
    expect(settings.body.available).toBe(true);

    const created = await request(app)
      .post(restUrl(COMPANY, "datasets"))
      .send({ name: "Manuals" })
      .expect(201);
    const datasetId = created.body.dataset.id as string;

    const uploaded = await request(app)
      .post(restUrl(COMPANY, `datasets/${datasetId}/documents`))
      .attach("file", Buffer.from(TEXT, "utf8"), { filename: "warranty.txt", contentType: "text/plain" })
      .expect(202);
    const documentId = uploaded.body.document.id as string;
    expect(uploaded.body.document.status).toBe("queued");
    const jobId = uploaded.body.job.id as string;

    // Searching before the worker ran finds nothing: only ready documents are searchable.
    const early = await request(app)
      .post(restUrl(COMPANY, `datasets/${datasetId}/search`))
      .send({ query: "warranty period" })
      .expect(200);
    expect(early.body.hits).toEqual([]);

    const swept = await newWorker().sweep();
    expect(swept).toMatchObject({ enabled: true, available: true, claimed: 1, parsed: 1, failed: 0 });
    expect(parseSubmissions).toContain("warranty.txt");

    const document = await request(app).get(restUrl(COMPANY, `documents/${documentId}`)).expect(200);
    expect(document.body.document.status).toBe("ready");
    expect(document.body.document.chunkCount).toBeGreaterThan(0);
    const job = await request(app).get(restUrl(COMPANY, `jobs/${jobId}`)).expect(200);
    expect(job.body.job.state).toBe("done");

    const found = await request(app)
      .post(restUrl(COMPANY, `datasets/${datasetId}/search`))
      .send({ query: "warranty period espresso machine" })
      .expect(200);
    expect(found.body.hits.length).toBeGreaterThan(0);
    expect(found.body.hits[0].documentId).toBe(documentId);
    expect(found.body.hits[0].text).toContain("espresso machine");

    // MCP: tools/list shows the four tools, corpus_search answers with the same document.
    const tools = await request(app).post(mcpUrl(COMPANY)).send({ id: 2, method: "tools/list" }).expect(200);
    expect((tools.body.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual([
      "corpus_get_document",
      "corpus_list_datasets",
      "corpus_list_documents",
      "corpus_search",
    ]);
    const called = await request(app)
      .post(mcpUrl(COMPANY))
      .send({ id: 3, method: "tools/call", params: { name: "corpus_search", arguments: { query: "warranty period espresso machine" } } })
      .expect(200);
    expect(called.body.result.isError).not.toBe(true);
    const hits = called.body.result.structuredContent.hits as Array<{ document: { id: string }; text: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.document.id).toBe(documentId);
    expect(hits[0]!.text).toContain("espresso machine");

    // Company isolation: another company sees neither the dataset nor the document.
    const otherApp = restApp(OTHER_COMPANY);
    const otherDatasets = await request(otherApp).get(restUrl(OTHER_COMPANY, "datasets")).expect(200);
    expect(otherDatasets.body.datasets).toEqual([]);
    const otherSearch = await request(otherApp)
      .post(mcpUrl(OTHER_COMPANY))
      .send({ id: 4, method: "tools/call", params: { name: "corpus_search", arguments: { query: "warranty period espresso machine" } } })
      .expect(200);
    expect(otherSearch.body.result.structuredContent.hits ?? []).toEqual([]);
    await request(otherApp).get(restUrl(OTHER_COMPANY, `documents/${documentId}`)).expect(404);
  });

  it("retries a document the parser rejects and then settles it as failed", async () => {
    await setCorpusBlock(enabledBlock());
    parserMode = "reject";
    try {
      const app = restApp(COMPANY);
      const created = await request(app).post(restUrl(COMPANY, "datasets")).send({ name: "Broken" }).expect(201);
      const datasetId = created.body.dataset.id as string;
      const uploaded = await request(app)
        .post(restUrl(COMPANY, `datasets/${datasetId}/documents`))
        .attach("file", Buffer.from("scan", "utf8"), { filename: "scan.bin", contentType: "application/octet-stream" })
        .expect(202);
      const documentId = uploaded.body.document.id as string;
      const jobId = uploaded.body.job.id as string;
      const worker = newWorker();

      const first = await worker.sweep();
      expect(first).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
      expect((await request(app).get(restUrl(COMPANY, `documents/${documentId}`)).expect(200)).body.document.status).toBe("queued");

      // The retry waits for its backoff.
      expect((await worker.sweep()).claimed).toBe(0);
      await db.execute(sql`update corpus_parse_jobs set next_attempt_at = now() where id = ${jobId}`);

      const second = await worker.sweep();
      expect(second).toMatchObject({ claimed: 1, requeued: 0, failed: 1 });
      const document = (await request(app).get(restUrl(COMPANY, `documents/${documentId}`)).expect(200)).body.document;
      expect(document.status).toBe("failed");
      expect(document.error).toBeTruthy();
      expect((await request(app).get(restUrl(COMPANY, `jobs/${jobId}`)).expect(200)).body.job.state).toBe("failed");
    } finally {
      parserMode = "ok";
    }
  });
});
