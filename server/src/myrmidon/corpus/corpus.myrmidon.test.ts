// server/src/myrmidon/corpus/corpus.myrmidon.test.ts
//
// myrmidon(1.6.6 CORPUS-2.0 ч.C): the corpus module driven over in-memory ports.
//
// What this file pins down:
//   - the module is OFF by default and a disabled (or unwired) module is silent:
//     no port is resolved, no job is claimed, the data routes answer 503 with
//     `corpus_disabled` and the settings route still answers (the switch itself
//     must be readable while the module is off);
//   - the settings page round-trips every field through the same normalizer the
//     vendor settings service uses, and a PATCH is an instance-admin action;
//   - the dataset/document/search/stat routes answer by company scope only;
//   - an uploaded document reaches `ready` through one parse pass (bytes →
//     BlobStore → queue → parse service → search index), and a failing parse
//     settles the document `failed` after `maxParseAttempts`.
//
// The ports here are in-memory fakes: parts A/B own the real store (Postgres +
// pgvector) and their own tests; this file is about what part C does with them.
import { Buffer } from "node:buffer";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  CORPUS_SETTINGS_KEYS,
  CORPUS_SETTINGS_PATH,
  corpusCompanyPrefix,
  DEFAULT_CORPUS_SETTINGS,
  mergeCorpusSettings,
  resolveCorpusSettings,
} from "@paperclipai/shared";
import type {
  CorpusDatasetRecord,
  CorpusDocumentRecord,
  CorpusJobRecord,
  CorpusPorts,
  CorpusSettings,
  ParsedChunk,
  ParsedDocument,
  SearchHitRecord,
} from "./ports.js";
import { myrmidonCorpusRoutes } from "./routes.js";
import {
  corpusService,
  CORPUS_DOCUMENT_DELETED_ACTION,
  CORPUS_DOCUMENT_UPLOADED_ACTION,
  CORPUS_SETTINGS_ACTION,
  type CorpusActor,
  type CorpusServiceDeps,
} from "./service.js";
import { createCorpusParseWorker } from "./worker.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const DATASET_ID = "33333333-3333-4333-8333-333333333333";
const AT = "2026-10-08T00:00:00.000Z";

// Actors exactly as the board's authz middleware builds them (see authz.ts).
const boardActor = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: true,
  companyIds: [COMPANY],
};
const memberActor = {
  type: "board",
  source: "session",
  userId: "user-b",
  isInstanceAdmin: false,
  companyIds: [COMPANY],
};
const strangerActor = {
  type: "board",
  source: "session",
  userId: "user-c",
  isInstanceAdmin: false,
  companyIds: [OTHER_COMPANY],
};

const actor: CorpusActor = {
  actorType: "user",
  actorId: "user-a",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

interface Harness {
  state: {
    datasets: Map<string, CorpusDatasetRecord>;
    documents: Map<string, CorpusDocumentRecord>;
    jobs: Map<string, CorpusJobRecord>;
    blobs: Map<string, Uint8Array>;
    chunks: Map<string, ParsedChunk[]>;
    stored: CorpusSettings | undefined;
    parse: ParsedDocument | Error | null;
  };
  calls: Record<"resolvePorts" | "claim" | "parse" | "index" | "indexDelete" | "complete" | "fail" | "blobDelete" | "updateGeneral", number>;
  audit: { action: string; companyId: string; entityType: string; entityId: string; details: Record<string, unknown> }[];
  ports: CorpusPorts;
  deps: CorpusServiceDeps;
  service: ReturnType<typeof corpusService>;
  worker: ReturnType<typeof createCorpusParseWorker>;
  seedDataset(id?: string): CorpusDatasetRecord;
  app(actorValue?: unknown): express.Express;
}

/** In-memory ports plus the two board services the module leans on. */
function corpusHarness(options: { env?: Record<string, string | undefined>; stored?: unknown; wired?: boolean } = {}): Harness {
  const state: Harness["state"] = {
    datasets: new Map(),
    documents: new Map(),
    jobs: new Map(),
    blobs: new Map(),
    chunks: new Map(),
    stored: options.stored as CorpusSettings | undefined,
    parse: { text: "hello corpus", chunks: [{ index: 0, text: "hello corpus" }] },
  };
  const calls: Harness["calls"] = {
    resolvePorts: 0,
    claim: 0,
    parse: 0,
    index: 0,
    indexDelete: 0,
    complete: 0,
    fail: 0,
    blobDelete: 0,
    updateGeneral: 0,
  };
  const audit: Harness["audit"] = [];
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const datasetOf = (companyId: string, datasetId: string) => {
    const found = state.datasets.get(datasetId);
    return found && found.companyId === companyId ? found : null;
  };
  const documentOf = (companyId: string, documentId: string) => {
    const found = state.documents.get(documentId);
    return found && found.companyId === companyId ? found : null;
  };
  const jobOf = (companyId: string, jobId: string) => {
    const found = state.jobs.get(jobId);
    return found && found.companyId === companyId ? found : null;
  };

  const ports: CorpusPorts = {
    store: {
      async listDatasets(companyId) {
        return [...state.datasets.values()].filter((row) => row.companyId === companyId);
      },
      async getDataset(companyId, datasetId) {
        return datasetOf(companyId, datasetId);
      },
      async createDataset({ companyId, name, description }) {
        const row: CorpusDatasetRecord = {
          id: nextId("d5"),
          companyId,
          name,
          description,
          createdAt: AT,
          updatedAt: AT,
          documentCount: 0,
          readyCount: 0,
          failedCount: 0,
          chunkCount: 0,
        };
        state.datasets.set(row.id, row);
        return row;
      },
      async updateDataset(companyId, datasetId, patch) {
        const row = datasetOf(companyId, datasetId);
        if (!row) return null;
        const next = { ...row, ...patch, updatedAt: AT };
        state.datasets.set(row.id, next);
        return next;
      },
      async deleteDataset(companyId, datasetId) {
        const row = datasetOf(companyId, datasetId);
        if (!row) return false;
        for (const document of [...state.documents.values()]) {
          if (document.datasetId === datasetId) state.documents.delete(document.id);
        }
        for (const job of [...state.jobs.values()]) {
          if (job.datasetId === datasetId) state.jobs.delete(job.id);
        }
        state.datasets.delete(datasetId);
        return true;
      },
      async listDocuments(companyId, datasetId, options) {
        const rows = [...state.documents.values()].filter(
          (row) => row.companyId === companyId && row.datasetId === datasetId,
        );
        const offset = options?.offset ?? 0;
        return options?.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + options.limit);
      },
      async getDocument(companyId, documentId) {
        return documentOf(companyId, documentId);
      },
      async createDocument(input) {
        const row: CorpusDocumentRecord = {
          id: nextId("d0"),
          companyId: input.companyId,
          datasetId: input.datasetId,
          filename: input.filename,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          blobRef: input.blobRef,
          status: "queued",
          chunkCount: 0,
          error: null,
          attempts: 0,
          createdAt: AT,
          updatedAt: AT,
          parsedAt: null,
        };
        state.documents.set(row.id, row);
        return row;
      },
      async updateDocument(companyId, documentId, patch) {
        const row = documentOf(companyId, documentId);
        if (!row) return null;
        const next = { ...row, ...patch, updatedAt: AT };
        state.documents.set(row.id, next);
        return next;
      },
      async deleteDocument(companyId, documentId) {
        const row = documentOf(companyId, documentId);
        if (!row) return false;
        state.documents.delete(documentId);
        for (const job of [...state.jobs.values()]) {
          if (job.documentId === documentId) state.jobs.delete(job.id);
        }
        state.blobs.delete(row.blobRef);
        state.chunks.delete(documentId);
        return true;
      },
      async countDocuments(companyId, datasetId) {
        return [...state.documents.values()].filter(
          (row) => row.companyId === companyId && row.datasetId === datasetId,
        ).length;
      },
      async getJob(companyId, jobId) {
        return jobOf(companyId, jobId);
      },
      async counters(companyId) {
        const documents = [...state.documents.values()].filter((row) => row.companyId === companyId);
        return {
          datasets: [...state.datasets.values()].filter((row) => row.companyId === companyId).length,
          documents: documents.length,
          ready: documents.filter((row) => row.status === "ready").length,
          pending: documents.filter((row) => row.status === "queued" || row.status === "parsing").length,
          failed: documents.filter((row) => row.status === "failed").length,
          chunks: documents.reduce((total, row) => total + row.chunkCount, 0),
          bytes: documents.reduce((total, row) => total + row.byteSize, 0),
        };
      },
    },
    blobs: {
      async put({ companyId, documentId, filename, bytes }) {
        const ref = `corpus/${companyId}/${documentId}/${filename}`;
        state.blobs.set(ref, bytes);
        return { ref, byteSize: bytes.byteLength };
      },
      async get(ref) {
        const bytes = state.blobs.get(ref);
        if (!bytes) throw new Error(`missing blob ${ref}`);
        return bytes;
      },
      async delete(ref) {
        calls.blobDelete += 1;
        state.blobs.delete(ref);
      },
    },
    queue: {
      async enqueue({ companyId, datasetId, documentId, maxAttempts }) {
        const job: CorpusJobRecord = {
          id: nextId("30"),
          companyId,
          datasetId,
          documentId,
          state: "queued",
          attempts: 0,
          maxAttempts,
          lastError: null,
          createdAt: AT,
          updatedAt: AT,
        };
        state.jobs.set(job.id, job);
        return job;
      },
      async claim({ limit }) {
        calls.claim += 1;
        const queued = [...state.jobs.values()].filter((job) => job.state === "queued").slice(0, limit);
        return queued.map((job) => {
          const running: CorpusJobRecord = { ...job, state: "running", attempts: job.attempts + 1, updatedAt: AT };
          state.jobs.set(job.id, running);
          return running;
        });
      },
      async complete(companyId, jobId) {
        calls.complete += 1;
        const job = jobOf(companyId, jobId);
        if (job) state.jobs.set(jobId, { ...job, state: "done", lastError: null });
      },
      async fail(companyId, jobId, reason) {
        calls.fail += 1;
        const job = jobOf(companyId, jobId);
        if (!job) return null;
        const settled: CorpusJobRecord =
          job.attempts >= job.maxAttempts
            ? { ...job, state: "failed", lastError: reason }
            : { ...job, state: "queued", lastError: reason };
        state.jobs.set(jobId, settled);
        return settled;
      },
    },
    parser: {
      async parse() {
        calls.parse += 1;
        if (state.parse instanceof Error) throw state.parse;
        return state.parse ?? { text: "", chunks: [] };
      },
    },
    index: {
      async indexDocument(input) {
        calls.index += 1;
        state.chunks.set(input.documentId, input.chunks);
        return input.chunks.length;
      },
      async deleteDocument(_companyId, documentId) {
        calls.indexDelete += 1;
        state.chunks.delete(documentId);
      },
      async search(input) {
        const rows = [...state.documents.values()].filter(
          (row) => row.companyId === input.companyId && row.datasetId === input.datasetId,
        );
        return rows
          .flatMap((row) =>
            (state.chunks.get(row.id) ?? []).map((chunk) => ({
              chunkId: `${row.id}:${chunk.index}`,
              documentId: row.id,
              datasetId: row.datasetId,
              score: 0.9,
              text: chunk.text,
              metadata: chunk.metadata ?? {},
            })),
          )
          .slice(0, input.limit);
      },
      async countChunks() {
        return [...state.chunks.values()].reduce((total, chunks) => total + chunks.length, 0);
      },
    },
  };

  const deps: CorpusServiceDeps = {
    settings: {
      async getGeneral() {
        return { corpus: state.stored };
      },
      async updateGeneral(patch) {
        calls.updateGeneral += 1;
        state.stored = patch.corpus;
        return { general: { corpus: patch.corpus } };
      },
    },
    listCompanyIds: async () => [COMPANY, OTHER_COMPANY],
    logActivity: async (entry) => {
      audit.push(entry);
    },
    ports: () => {
      calls.resolvePorts += 1;
      return options.wired === false ? null : ports;
    },
    env: options.env,
  };

  const service = corpusService({} as Db, deps);
  const worker = createCorpusParseWorker({
    ports: deps.ports,
    resolveSettings: async () => {
      const view = await service.readSettings();
      return { settings: view.settings, enabled: view.enabled };
    },
  });

  const seedDataset = (datasetId = DATASET_ID): CorpusDatasetRecord => {
    const row: CorpusDatasetRecord = {
      id: datasetId,
      companyId: COMPANY,
      name: "Runbooks",
      description: null,
      createdAt: AT,
      updatedAt: AT,
      documentCount: 0,
      readyCount: 0,
      failedCount: 0,
      chunkCount: 0,
    };
    state.datasets.set(row.id, row);
    return row;
  };

  // The board app minus the vendor chain: JSON, an actor, the module's router and
  // the error shim the vendor app installs once (see agent-memory's route test).
  const app = (actorValue: unknown = boardActor) => {
    const server = express();
    server.use(express.json());
    server.use((req: Request, _res: Response, next: NextFunction) => {
          (req as unknown as { actor?: unknown }).actor = actorValue;
          next();
        });
    server.use(
      "/api",
      myrmidonCorpusRoutes({} as Db, {
        ports: deps.ports,
        env: options.env,
        serviceDeps: {
          settings: deps.settings,
          logActivity: deps.logActivity,
          listCompanyIds: deps.listCompanyIds,
        },
      }),
    );
    server.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const error = err as {
        status?: number;
        code?: string;
        name?: string;
        message?: string;
        details?: unknown;
        issues?: unknown;
      };
      const status = typeof error.status === "number" ? error.status : error.name === "ZodError" ? 400 : 500;
      res.status(status).json({
        error: error.code ?? error.name ?? "error",
        message: error.message ?? "error",
        details: error.details ?? error.issues ?? {},
      });
    });
    return server;
  };

  return { state, calls, audit, ports, deps, service, worker, seedDataset, app };
}

const companyPath = (companyId: string = COMPANY) => `/api/myrmidon/companies/${companyId}/corpus`;
const datasetPath = (datasetId: string = DATASET_ID, companyId: string = COMPANY) =>
  `${companyPath(companyId)}/datasets/${datasetId}`;
const settingsPath = "/api/myrmidon/corpus/settings";

describe("corpus module: off by default and silent while off", () => {
  it("reads the built-in defaults without ever building a port", async () => {
    const h = corpusHarness();
    const view = await h.service.readSettings();

    expect(view.settings).toEqual(DEFAULT_CORPUS_SETTINGS);
    expect(view.enabled).toBe(false);
    // `available` is false while the module is off on purpose: the resolver is
    // not consulted at all, so an instance that never enables the module never
    // opens a connection to answer its own settings page.
    expect(view.available).toBe(false);
    expect(view.sources.enabled).toBe("default");
    expect(h.calls.resolvePorts).toBe(0);
  });

  it("takes the switch and the parse service from the environment until a save lands", async () => {
    const h = corpusHarness({
      env: {
        MYRMIDON_CORPUS_ENABLED: "true",
        MYRMIDON_CORPUS_PARSER_BASE_URL: "http://parser:8080",
        MYRMIDON_CORPUS_EMBEDDER_MODEL: "text-embedding-v4",
      },
    });
    const view = await h.service.readSettings();

    expect(view.enabled).toBe(true);
    expect(view.settings.parserBaseUrl).toBe("http://parser:8080");
    expect(view.available).toBe(true);
    expect(view.sources.enabled).toBe("env");
    expect(view.sources.parserTimeoutMs).toBe("default");
  });

  it("answers 503 corpus_disabled on every data route of a company", async () => {
    const h = corpusHarness();
    h.seedDataset();
    const app = h.app();

    const calls = [
      request(app).get(`${companyPath()}/datasets`),
      request(app).post(`${companyPath()}/datasets`).send({ name: "Runbooks" }),
      request(app).get(datasetPath()),
      request(app).patch(datasetPath()).send({ name: "Renamed" }),
      request(app).delete(datasetPath()),
      request(app).get(`${datasetPath()}/documents`),
      request(app)
        .post(`${datasetPath()}/documents`)
        .attach("file", Buffer.from("hello corpus"), "note.txt"),
      request(app).post(`${datasetPath()}/search`).send({ query: "hello" }),
      request(app).get(`${companyPath()}/stats`),
    ];
    for (const call of calls) {
      const response = await call;
      expect(response.status).toBe(503);
      expect(response.body.error).toBe("corpus_disabled");
    }
    // Nothing was claimed, indexed or written: the dataset is untouched.
    expect(h.state.datasets.get(DATASET_ID)?.name).toBe("Runbooks");
    expect(h.state.blobs.size).toBe(0);
    expect(h.calls.claim).toBe(0);
  });

  it("still answers the settings page while the module is off", async () => {
    const h = corpusHarness();
    const response = await request(h.app()).get(settingsPath);

    expect(response.status).toBe(200);
    expect(response.body.enabled).toBe(false);
    expect(response.body.available).toBe(false);
    expect(response.body.settings).toEqual(DEFAULT_CORPUS_SETTINGS);
    expect(response.body.sources.enabled).toBe("default");
  });

  it("says corpus_not_configured when the module is on but the ports are not wired", async () => {
    const h = corpusHarness({ env: { MYRMIDON_CORPUS_ENABLED: "true" }, wired: false });
    const response = await request(h.app()).get(`${companyPath()}/datasets`);

    expect(response.status).toBe(503);
    expect(response.body.error).toBe("corpus_not_configured");
  });

  it("is a no-op sweep while the module is off — no claim, no port, no log", async () => {
    const h = corpusHarness();
    const result = await h.worker.sweep();

    expect(result.enabled).toBe(false);
    expect(result.claimed).toBe(0);
    expect(h.calls.claim).toBe(0);
    expect(h.calls.resolvePorts).toBe(0);
  });
});

describe("corpus settings: the instance block drives the module", () => {
  const block = {
    enabled: true,
    parserBaseUrl: "http://parser:8080",
    parserTimeoutMs: 45_000,
    embedderModel: "text-embedding-v4",
    embedderDimensions: 1024,
    embedderBaseUrl: "http://litellm:4000",
    maxDocumentBytes: 5 * 1024 * 1024,
    maxDocumentsPerDataset: 500,
    parseConcurrency: 4,
    maxParseAttempts: 4,
    searchTopK: 8,
  };

  it("round-trips every field of the block and keeps the rest of it intact", async () => {
    // The frozen shape part E builds its form from: the block is exactly the
    // contract's keys, no more and no less.
    expect(Object.keys(block).sort()).toEqual([...CORPUS_SETTINGS_KEYS].sort());

    const h = corpusHarness();
    const saved = await request(h.app()).patch(settingsPath).send(block);

    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual(block);
    expect(saved.body.enabled).toBe(true);
    expect(saved.body.available).toBe(true);
    expect(saved.body.sources.enabled).toBe("stored");
    // Nothing of the block is left behind: the read path resolves the same values.
    expect((await request(h.app()).get(settingsPath)).body.settings).toEqual(block);

    // A one-field save merges into the stored block instead of replacing it.
    const partial = await request(h.app()).patch(settingsPath).send({ maxParseAttempts: 6 });
    expect(partial.status).toBe(200);
    expect(partial.body.settings).toEqual({ ...block, maxParseAttempts: 6 });
    expect(h.state.stored).toEqual({ ...block, maxParseAttempts: 6 });
  });

  it("audits a settings save once per company and names what changed", async () => {
    const h = corpusHarness();
    await request(h.app()).patch(settingsPath).send(block);
    await request(h.app()).patch(settingsPath).send({ enabled: false });

    expect(h.calls.updateGeneral).toBe(2);
    expect(h.audit).toHaveLength(4); // two companies × two saves
    expect(h.audit[0]).toMatchObject({
      action: CORPUS_SETTINGS_ACTION,
      companyId: COMPANY,
      entityType: "instance_settings",
      entityId: "default",
      actorType: "user",
      actorId: "user-a",
    });
    expect(h.audit[2].details.changedKeys).toEqual(["enabled"]);
    // `previous` carries the settings in force before the save.
    expect(h.audit[2].details.previous).toEqual(block);
    expect((h.audit[0].details.next as Record<string, unknown>).parserTimeoutMs).toBe(45_000);
  });

  it("only an instance admin may write the block", async () => {
    const h = corpusHarness();
    const refused = await request(h.app(memberActor)).patch(settingsPath).send({ enabled: true });

    expect(refused.status).toBe(403);
    expect(h.calls.updateGeneral).toBe(0);

    expect((await request(h.app(boardActor)).patch(settingsPath).send({ enabled: true })).status).toBe(200);
  });

  it("rejects a typo and an out-of-bounds value without saving", async () => {
    const h = corpusHarness();

    // `chunkSize` is part B's business, not a settings key: the body is strict.
    expect((await request(h.app()).patch(settingsPath).send({ chunkSize: 900 })).status).toBe(400);
    // `searchTopK` tops out at 50.
    expect((await request(h.app()).patch(settingsPath).send({ searchTopK: 500 })).status).toBe(400);
    expect((await request(h.app()).patch(settingsPath).send({ enabled: "yes" })).status).toBe(400);
    expect(h.calls.updateGeneral).toBe(0);
    expect(h.audit).toHaveLength(0);
  });

  it("materializes the block on a save that moves nothing", async () => {
    const h = corpusHarness({
      env: { MYRMIDON_CORPUS_ENABLED: "true", MYRMIDON_CORPUS_PARSER_BASE_URL: "http://parser:8080" },
    });
    const response = await request(h.app()).patch(settingsPath).send({});

    expect(response.status).toBe(200);
    // What was in force moves into the stored block verbatim, and the reader no
    // longer reports the environment as the source.
    expect(h.state.stored).toMatchObject({ enabled: true, parserBaseUrl: "http://parser:8080" });
    expect((await request(h.app()).get(settingsPath)).body.sources.enabled).toBe("stored");
    // Nothing moved in the values, so nothing is written to the audit trail.
    expect(h.audit).toHaveLength(0);
  });

  it("round-trips the frozen block through stored JSON without losing a field", () => {
    // The shape the settings page sends, the store keeps and the UI service
    // hands back — exercised without a database.
    const before = resolveCorpusSettings({ env: {} });
    const saved = mergeCorpusSettings(before.settings, block);
    const stored = JSON.parse(JSON.stringify({ corpus: saved })) as { corpus: unknown };
    const after = resolveCorpusSettings({ stored: stored.corpus, env: {} });

    expect(after.settings).toEqual(saved);
    expect(after.settings).toEqual({ ...DEFAULT_CORPUS_SETTINGS, ...block });
    expect(after.enabled).toBe(true);
    expect(Object.values(after.sources).every((source) => source === "stored")).toBe(true);
  });

  it("falls back field by field when the stored block carries junk", () => {
    const resolved = resolveCorpusSettings({
      stored: { enabled: true, parserTimeoutMs: "soon", searchTopK: 12 },
      env: { MYRMIDON_CORPUS_MAX_PARSE_ATTEMPTS: "5" },
    });

    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.settings.searchTopK).toBe(12);
    expect(resolved.settings.maxParseAttempts).toBe(5);
    // The junk keeps its own default instead of poisoning the whole block…
    expect(resolved.settings.parserTimeoutMs).toBe(DEFAULT_CORPUS_SETTINGS.parserTimeoutMs);
    expect(resolved.sources.parserTimeoutMs).toBe("default");
    // …and every key says where its value came from.
    expect(resolved.sources.enabled).toBe("stored");
    expect(resolved.sources.searchTopK).toBe("stored");
    expect(resolved.sources.maxParseAttempts).toBe("env");
  });

  it("keeps the settings page away from callers who are not on the board", async () => {
    const h = corpusHarness();
    const anonymous = await request(h.app({ type: "none" })).get(settingsPath);
    // The block is an instance card, so it reads like the runtime-limits one:
    // any board member may look at it, and the settings page has to work while
    // the module is off — otherwise nobody could ever switch it on.
    const strangerRead = await request(h.app(strangerActor)).get(settingsPath);
    const strangerWrite = await request(h.app(strangerActor)).patch(settingsPath).send({ enabled: true });

    expect([401, 403]).toContain(anonymous.status);
    expect(strangerRead.status).toBe(200);
    expect(strangerRead.body.settings.enabled).toBe(false);
    // …but writing it stays with the instance admin.
    expect(strangerWrite.status).toBe(403);
    expect(h.calls.updateGeneral).toBe(0);
  });
});

describe("corpus API: datasets live inside a company", () => {
  const enabled = () =>
    corpusHarness({
      env: { MYRMIDON_CORPUS_ENABLED: "true", MYRMIDON_CORPUS_PARSER_BASE_URL: "http://parser:8080" },
    });

  it("creates, lists, renames and deletes a dataset", async () => {
    // The paths the UI and the MCP tools build are the contract's own helpers.
    expect(companyPath()).toBe(corpusCompanyPrefix(COMPANY));
    expect(settingsPath).toBe(CORPUS_SETTINGS_PATH);

    const h = enabled();
    const app = h.app();

    const created = await request(app)
      .post(`${companyPath()}/datasets`)
      .send({ name: "Runbooks", description: "ops notes" });
    expect(created.status).toBe(201);
    const datasetId = created.body.dataset.id as string;
    expect(created.body.dataset).toMatchObject({
      name: "Runbooks",
      description: "ops notes",
      documentCount: 0,
    });
    expect(h.audit).toHaveLength(0); // creating a dataset is not an audited event

    expect((await request(app).get(`${companyPath()}/datasets`)).body.datasets.map((row: { id: string }) => row.id)).toEqual([
      datasetId,
    ]);

    const renamed = await request(app).patch(`${companyPath()}/datasets/${datasetId}`).send({ name: "Handbook" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.dataset.name).toBe("Handbook");
    // A name-only patch leaves the description alone.
    expect(renamed.body.dataset.description).toBe("ops notes");
    expect((await request(app).get(`${companyPath()}/datasets/${datasetId}`)).body.dataset.name).toBe("Handbook");

    expect((await request(app).delete(`${companyPath()}/datasets/${datasetId}`)).status).toBe(204);
    expect((await request(app).get(`${companyPath()}/datasets/${datasetId}`)).status).toBe(404);
    expect((await request(app).get(`${companyPath()}/datasets`)).body.datasets).toEqual([]);
  });

  it("keeps one company's corpus out of another company's reach", async () => {
    const h = enabled();
    h.seedDataset();

    const stranger = h.app(strangerActor);
    expect((await request(stranger).get(`${companyPath()}/datasets`)).status).toBe(403);
    expect((await request(stranger).get(datasetPath())).status).toBe(403);
    // A company actor that reaches for another company's scope is refused too.
    expect((await request(h.app()).get(`${companyPath(OTHER_COMPANY)}/stats`)).status).toBe(403);
    expect((await request(h.app()).get(`${companyPath(OTHER_COMPANY)}/datasets`)).status).toBe(403);
    // In its own scope the same dataset answers, so the 403s above are the guard,
    // not a missing row.
    expect((await request(h.app()).get(datasetPath())).status).toBe(200);
  });

  it("validates the bodies and reports a missing dataset as 404", async () => {
    const h = enabled();
    const app = h.app();

    expect((await request(app).post(`${companyPath()}/datasets`).send({ name: "   " })).status).toBe(400);
    expect((await request(app).post(`${companyPath()}/datasets`).send({ name: "x".repeat(500) })).status).toBe(400);
    expect((await request(app).post(`${companyPath()}/datasets`).send({})).status).toBe(400);
    expect((await request(app).patch(`${companyPath()}/datasets/${DATASET_ID}`).send({})).status).toBe(400);
    expect((await request(app).post(`${companyPath()}/datasets/${DATASET_ID}/search`).send({ query: "" })).status).toBe(400);

    expect((await request(app).get(datasetPath())).status).toBe(404);
    expect((await request(app).get(`${datasetPath()}/documents`)).status).toBe(404);
    expect((await request(app).post(`${datasetPath()}/search`).send({ query: "hi" })).status).toBe(404);
    expect((await request(app).get(`${companyPath()}/documents/unknown`)).status).toBe(404);
    expect((await request(app).get(`${companyPath()}/jobs/unknown`)).status).toBe(404);
  });
});

describe("corpus API: upload, parse and search", () => {
  type TestApp = ReturnType<typeof express>;

  const enabled = (env: Record<string, string> = {}) =>
    corpusHarness({
      env: {
        MYRMIDON_CORPUS_ENABLED: "true",
        MYRMIDON_CORPUS_PARSER_BASE_URL: "http://parser:8080",
        ...env,
      },
    });

  const upload = (app: TestApp, datasetId: string = DATASET_ID, body = "hello corpus", filename = "notes.txt") =>
    request(app)
      .post(`${companyPath()}/datasets/${datasetId}/documents`)
      .attach("file", Buffer.from(body), { filename, contentType: "text/plain" });

  it("takes a document into the BlobStore and the parse queue", async () => {
    const h = enabled();
    h.seedDataset();
    const app = h.app();

    const response = await upload(app);

    expect(response.status).toBe(202);
    expect(response.body.document).toMatchObject({
      status: "queued",
      filename: "notes.txt",
      mimeType: "text/plain",
      byteSize: 12,
      chunkCount: 0,
      error: null,
    });
    expect(response.body.job).toMatchObject({ state: "queued", attempts: 0, maxAttempts: 3 });
    // The bytes are in the BlobStore, a job waits, and the index is still empty.
    expect(h.state.blobs.size).toBe(1);
    expect(h.state.jobs.size).toBe(1);
    expect(h.state.chunks.size).toBe(0);
    expect(h.audit.map((row) => row.action)).toEqual([CORPUS_DOCUMENT_UPLOADED_ACTION]);
    expect(h.audit[0].details).toMatchObject({ datasetId: DATASET_ID, filename: "notes.txt", byteSize: 12});
    expect((await request(app).get(`${companyPath()}/datasets/${DATASET_ID}/documents`)).body.documents).toHaveLength(1);
  });

  it("parses the uploaded document to ready on the next sweep, and search finds it", async () => {
    const h = enabled();
    h.seedDataset();
    const app = h.app();
    const uploaded = await upload(app);
    const documentId = uploaded.body.document.id as string;
    const jobId = uploaded.body.job.id as string;

    const sweep = await h.worker.sweep();
    expect(sweep).toMatchObject({ enabled: true, available: true, claimed: 1, parsed: 1, requeued: 0, failed: 0 });
    expect(h.calls.parse).toBe(1);
    expect(h.calls.index).toBe(1);
    expect(h.calls.complete).toBe(1);

    const document = (await request(app).get(`${companyPath()}/documents/${documentId}`)).body.document;
    expect(document).toMatchObject({ status: "ready", chunkCount: 1, error: null });
    expect(document.parsedAt).toBeTruthy();
    expect((await request(app).get(`${companyPath()}/jobs/${jobId}`)).body.job).toMatchObject({ state: "done" });

    const found = await request(app)
      .post(`${companyPath()}/datasets/${DATASET_ID}/search`)
      .send({ query: "  corpus  " });
    expect(found.status).toBe(200);
    // The query is trimmed, the mode defaults to hybrid and the limit comes from
    // the settings block (searchTopK), not from a route constant.
    expect(found.body).toMatchObject({ datasetId: DATASET_ID, query: "corpus", mode: "hybrid", limit: 5 });
    expect(found.body.hits).toHaveLength(1);
    expect(found.body.hits[0]).toMatchObject({ text: "hello corpus", score: 0.9 });

    // The counters the screen reads follow the same rows.
    const stats = (await request(app).get(`${companyPath()}/stats`)).body.stats;
    expect(stats).toMatchObject({ datasets: 1, documents: 1, ready: 1, pending: 0, failed: 0, chunks: 1, bytes: 12 });
  });

  it("retries a failed parse and gives up on the last attempt", async () => {
    const h = enabled();
    h.seedDataset();
    const app = h.app();
    const uploaded = await upload(app);
    const documentId = uploaded.body.document.id as string;
    h.state.parse = new Error("the parse service answered 502");

    // maxParseAttempts defaults to 3: two requeues, then the document fails.
    expect(await h.worker.sweep()).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
    expect(h.state.documents.get(documentId)?.status).toBe("queued");
    expect(h.state.documents.get(documentId)?.error).toContain("502");

    expect(await h.worker.sweep()).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
    const last = await h.worker.sweep();

    expect(last).toMatchObject({ claimed: 1, parsed: 0, requeued: 0, failed: 1 });
    const document = (await request(app).get(`${companyPath()}/documents/${documentId}`)).body.document;
    expect(document).toMatchObject({ status: "failed", chunkCount: 0 });
    expect(document.error).toContain("502");
    // A failed document is not left in the queue: the next pass claims nothing.
    expect(await h.worker.sweep()).toMatchObject({ claimed: 0, parsed: 0, failed: 0 });
  });

  it("refuses an oversized upload and a full dataset", async () => {
    const h = enabled({ MYRMIDON_CORPUS_MAX_DOCUMENT_BYTES: "16", MYRMIDON_CORPUS_MAX_DOCUMENTS_PER_DATASET: "1" });
    h.seedDataset();
    const app = h.app();

    const tooBig = await upload(app, DATASET_ID, "x".repeat(64));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error).toBe("document_too_large");
    expect(h.state.blobs.size).toBe(0);

    expect((await upload(app, DATASET_ID, "small")).status).toBe(202);
    const full = await upload(app, DATASET_ID, "small");
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("dataset_full");
  });

  it("keeps a process without ports silent, even with the module switched on", async () => {
    const h = corpusHarness({ wired: false, env: { MYRMIDON_CORPUS_ENABLED: "true" } });
    h.seedDataset();
    const app = h.app();

    expect(await h.worker.sweep()).toMatchObject({ enabled: true, available: false, claimed: 0 });
    expect(h.calls.claim).toBe(0);
    // The API says why it cannot serve instead of pretending the corpus is empty.
    const blocked = await request(app).get(`${companyPath()}/datasets`);
    expect(blocked.status).toBe(503);
    expect(blocked.body.error).toBe("corpus_not_configured");
  });

  it("drops a deleted document out of the store, the index and the BlobStore", async () => {
    const h = enabled();
    h.seedDataset();
    const app = h.app();
    const uploaded = await upload(app);
    const documentId = uploaded.body.document.id as string;
    await h.worker.sweep();

    expect(h.state.chunks.size).toBe(1);
    expect((await request(app).delete(`${companyPath()}/documents/${documentId}`)).status).toBe(204);

    expect(h.state.documents.has(documentId)).toBe(false);
    expect(h.state.chunks.size).toBe(0);
    expect(h.calls.indexDelete).toBe(1);
    expect(h.calls.blobDelete).toBe(1);
    expect(h.state.blobs.size).toBe(0);
    expect(h.audit.map((row) => row.action)).toContain(CORPUS_DOCUMENT_DELETED_ACTION);
    expect((await request(app).get(`${companyPath()}/documents/${documentId}`)).status).toBe(404);
  });
});