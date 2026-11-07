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
import type { Db } from "@myrmidon/db";
import {
  CORPUS_SETTINGS_KEYS,
  CORPUS_SETTINGS_PATH,
  corpusCompanyPrefix,
  DEFAULT_CORPUS_SETTINGS,
  mergeCorpusSettings,
  resolveCorpusSettings,
} from "@myrmidon/shared";
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
import { guardedRemoteHttpFetch } from "../../services/remote-http-fetch.js";
import { createCorpusSourceRefresher } from "./source.js";
import { createCorpusUrlFetcher, sha256Hex, type CorpusUrlFetcher } from "./source-fetch.js";
import {
  CorpusRequestError,
  corpusService,
  CORPUS_DOCUMENT_DELETED_ACTION,
  CORPUS_DOCUMENT_REFRESHED_ACTION,
  CORPUS_DOCUMENT_REPARSED_ACTION,
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
    embedderConfigured?: boolean;
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
function corpusHarness(
  options: { env?: Record<string, string | undefined>; stored?: unknown; wired?: boolean; fetchUrl?: CorpusUrlFetcher } = {},
): Harness {
  const state: Harness["state"] = {
    datasets: new Map(),
    documents: new Map(),
    jobs: new Map(),
    blobs: new Map(),
    chunks: new Map(),
    stored: options.stored as CorpusSettings | undefined,
    parse: { text: "hello corpus", chunks: [{ index: 0, text: "hello corpus" }] },
    embedderConfigured: true,
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
  let blobSequence = 0;
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
          sourceUrl: input.source?.url ?? null,
          refreshIntervalHours: input.source?.refreshIntervalHours ?? null,
          contentHash: input.source?.contentHash ?? null,
          lastFetchedAt: input.source?.fetchedAt ?? null,
          sourceError: null,
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
      async listSourceDocuments({ companyId, datasetId, dueAt, limit }) {
        return [...state.documents.values()]
          .filter((row) => row.sourceUrl !== null)
          .filter((row) => !companyId || row.companyId === companyId)
          .filter((row) => !datasetId || row.datasetId === datasetId)
          .filter(
            (row) =>
              !dueAt ||
              new Date(row.lastFetchedAt ?? row.createdAt).getTime() + (row.refreshIntervalHours ?? 168) * 3_600_000 <=
                dueAt.getTime(),
          )
          .slice(0, limit);
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
        // Unique per write, like the production key: a replaced version must not overwrite the old one.
        const ref = `corpus/${companyId}/${documentId}/${++blobSequence}-${filename}`;
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
      async enqueue({ companyId, datasetId, documentId, maxAttempts, reset }) {
        // Like the Postgres queue: one job per document; a failed one (or any one, with `reset`)
        // starts over instead of a second job being created.
        const existing = [...state.jobs.values()].find(
          (row) => row.companyId === companyId && row.documentId === documentId,
        );
        if (existing) {
          if (!reset && existing.state !== "failed") return existing;
          const rearmed: CorpusJobRecord = {
            ...existing,
            state: "queued",
            attempts: 0,
            maxAttempts: Math.max(existing.maxAttempts, maxAttempts),
            lastError: null,
            updatedAt: AT,
          };
          state.jobs.set(existing.id, rearmed);
          return rearmed;
        }
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
      async assertEmbedderConfigured(_companyId, _baseUrl) {
        if (state.embedderConfigured === false) {
          throw new CorpusRequestError(
            422,
            "corpus_embedder_not_configured",
            "the corpus embedder is not configured for this company: missing secret MYRMIDON_CORPUS_EMBEDDER_API_KEY",
            { hint: "Configure the active company secret MYRMIDON_CORPUS_EMBEDDER_API_KEY or set embedderBaseUrl." },
          );
        }
      },
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
    fetchUrl: options.fetchUrl,
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
          fetchUrl: options.fetchUrl,
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
        MYRMIDON_CORPUS_EMBEDDER_MODEL: "corpus-embed-pplx-0.6b",
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
      request(app).post(`${companyPath()}/documents/${DATASET_ID}/reparse`),
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
    embedderModel: "corpus-embed-pplx-0.6b",
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

  it("takes a parse time limit of up to two hours and refuses more", async () => {
    const h = corpusHarness();
    // A scanned book of 300 pages needs about 25 minutes of OCR: the old ceiling was ten minutes.
    const saved = await request(h.app()).patch(settingsPath).send({ parserTimeoutMs: 7_200_000 });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.parserTimeoutMs).toBe(7_200_000);
    expect((await request(h.app()).patch(settingsPath).send({ parserTimeoutMs: 1_800_000 })).status).toBe(200);
    expect((await request(h.app()).patch(settingsPath).send({ parserTimeoutMs: 7_200_001 })).status).toBe(400);
    expect((await request(h.app()).patch(settingsPath).send({ parserTimeoutMs: 999 })).status).toBe(400);
    expect(h.state.stored?.parserTimeoutMs).toBe(1_800_000);
    // The environment default follows the same bound.
    expect(
      resolveCorpusSettings({ stored: undefined, env: { MYRMIDON_CORPUS_PARSER_TIMEOUT_MS: "7200000" } }).settings.parserTimeoutMs,
    ).toBe(7_200_000);
    expect(
      resolveCorpusSettings({ stored: undefined, env: { MYRMIDON_CORPUS_PARSER_TIMEOUT_MS: "7200001" } }).settings.parserTimeoutMs,
    ).toBe(DEFAULT_CORPUS_SETTINGS.parserTimeoutMs);
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

  // Clients send the file name in `Content-Disposition` as raw UTF-8 bytes. Multer
  // reads header parameters as latin1 unless told otherwise, which turned a
  // Cyrillic name into mojibake in the stored title and in every API answer.
  it.each([
    { script: "Cyrillic", filename: "Руководство по запуску.pdf" },
    { script: "Cyrillic with spaces, dots and brackets", filename: "Отчёт (черновик) v2.1.txt" },
    { script: "Chinese", filename: "文档说明.txt" },
    { script: "accented Latin", filename: "Café menu – été.txt" },
    { script: "ASCII", filename: "notes v2.txt" },
  ])("keeps a $script file name intact from the upload to the store", async ({ filename }) => {
    const h = enabled();
    h.seedDataset();
    const app = h.app();

    const response = await upload(app, DATASET_ID, "hello corpus", filename);

    expect(response.status).toBe(202);
    expect(response.body.document.filename).toBe(filename);
    // What reached the upload service is what the store saved and the audit log named.
    expect([...h.state.documents.values()].map((document) => document.filename)).toEqual([filename]);
    expect(h.audit[0].details).toMatchObject({ filename });
    const listed = await request(app).get(`${companyPath()}/datasets/${DATASET_ID}/documents`);
    expect(listed.body.documents.map((document: { filename: string }) => document.filename)).toEqual([filename]);
  });

  it("runs queued parses concurrently up to the configured cap", async () => {
    const h = enabled({ MYRMIDON_CORPUS_PARSE_CONCURRENCY: "2" });
    h.seedDataset();
    const app = h.app();
    const uploads = await Promise.all([
      upload(app, DATASET_ID, "first page", "first.txt"),
      upload(app, DATASET_ID, "second page", "second.txt"),
      upload(app, DATASET_ID, "third page", "third.txt"),
    ]);
    expect(uploads.map((response) => response.status)).toEqual([202, 202, 202]);

    let activeParses = 0;
    let peakParses = 0;
    let releaseParses: (() => void) | undefined;
    const parseGate = new Promise<void>((resolve) => { releaseParses = resolve; });
    h.ports.parser.parse = async () => {
      activeParses += 1;
      peakParses = Math.max(peakParses, activeParses);
      await parseGate;
      activeParses -= 1;
      return { text: "parallel corpus", chunks: [{ index: 0, text: "parallel corpus" }] };
    };

    const sweepPromise = h.worker.sweep();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peakParses).toBe(2);
    releaseParses!();
    const sweep = await sweepPromise;

    expect(sweep).toMatchObject({ enabled: true, available: true, claimed: 2, parsed: 2, requeued: 0, failed: 0 });
    expect(activeParses).toBe(0);
    expect([...h.state.documents.values()].filter((document) => document.status === "ready")).toHaveLength(2);
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

  it("checks embedder before search and upload: returns 422 corpus_embedder_not_configured with hint, marks document failed", async () => {
    const h = enabled();
    h.seedDataset();
    const app = h.app();

    // Disable embedder configuration
    h.state.embedderConfigured = false;

    // Search branch: non-fulltext search fails with 422 corpus_embedder_not_configured and hint
    const searchRes = await request(app)
      .post(`${companyPath()}/datasets/${DATASET_ID}/search`)
      .send({ query: "find something", mode: "hybrid" });
    expect(searchRes.status).toBe(422);
    expect(searchRes.body.error).toBe("corpus_embedder_not_configured");
    expect(searchRes.body.hint).toBeTruthy();

    // Fulltext search does not require an embedder
    const fulltextRes = await request(app)
      .post(`${companyPath()}/datasets/${DATASET_ID}/search`)
      .send({ query: "find something", mode: "fulltext" });
    expect(fulltextRes.status).toBe(200);

    // Upload branch: upload fails with 422 corpus_embedder_not_configured and hint
    const uploadRes = await upload(app, DATASET_ID, "plain content");
    expect(uploadRes.status).toBe(422);
    expect(uploadRes.body.error).toBe("corpus_embedder_not_configured");
    expect(uploadRes.body.hint).toBeTruthy();

    // Document is recorded with status 'failed' and reason
    const docId = uploadRes.body.documentId as string;
    expect(docId).toBeTruthy();
    const docRes = await request(app).get(`${companyPath()}/documents/${docId}`);
    expect(docRes.status).toBe(200);
    expect(docRes.body.document.status).toBe("failed");
    expect(docRes.body.document.error).toContain("corpus_embedder_not_configured");

    // No blob stored and no job enqueued for the unconfigured upload
    expect(h.state.blobs.size).toBe(0);
    expect(h.state.jobs.size).toBe(0);
  });

  it("holds the parseConcurrency cap across passes that overlap", async () => {
    // A pass lasts as long as its slowest parse while the scheduler starts a new one every
    // CORPUS_PARSE_SWEEP_INTERVAL_MS: a pass must not claim more than the slots still free.
    const h = enabled({ MYRMIDON_CORPUS_PARSE_CONCURRENCY: "2" });
    h.seedDataset();
    const app = h.app();
    for (const name of ["a", "b", "c", "d", "e"]) await upload(app, DATASET_ID, `book ${name}`, `${name}.txt`);

    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    h.ports.parser.parse = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
      return { text: "book", chunks: [{ index: 0, text: "book" }] };
    };

    const first = h.worker.sweep();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(2);

    // Ticks while both parses are still running claim nothing, however many are queued.
    expect(await h.worker.sweep()).toMatchObject({ enabled: true, available: true, claimed: 0 });
    expect(await h.worker.sweep()).toMatchObject({ claimed: 0 });
    expect(h.calls.claim).toBe(1);
    expect(active).toBe(2);

    gates.splice(0).forEach((release) => release());
    expect(await first).toMatchObject({ claimed: 2, parsed: 2 });

    // Both slots are free again: the next pass takes the next two, and no more.
    const second = h.worker.sweep();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(2);
    gates.splice(0).forEach((release) => release());
    expect(await second).toMatchObject({ claimed: 2, parsed: 2 });
    expect(peak).toBe(2);
    expect([...h.state.jobs.values()].filter((job) => job.state === "queued")).toHaveLength(1);
  });

  it("frees the slots of a pass whose jobs fail, and of a claim that throws", async () => {
    const h = enabled({ MYRMIDON_CORPUS_PARSE_CONCURRENCY: "1" });
    h.seedDataset();
    await upload(h.app(), DATASET_ID, "one", "one.txt");
    h.state.parse = new Error("the parse service answered 502");
    expect(await h.worker.sweep()).toMatchObject({ claimed: 1, requeued: 1 });
    expect(await h.worker.sweep()).toMatchObject({ claimed: 1, requeued: 1 }); // the slot was free again

    const claim = h.ports.queue.claim;
    h.ports.queue.claim = async () => {
      throw new Error("the database went away");
    };
    await expect(h.worker.sweep()).rejects.toThrow("the database went away");
    h.ports.queue.claim = claim;
    expect(await h.worker.sweep()).toMatchObject({ claimed: 1, failed: 1 }); // third attempt: the slot was released
  });

  describe("parsing a failed document again", () => {
    const failedDocument = async (h: ReturnType<typeof enabled>, app: TestApp) => {
      const uploaded = await upload(app, DATASET_ID, "a big book", "book.pdf");
      const documentId = uploaded.body.document.id as string;
      h.state.parse = new Error("the parse service answered 502");
      await h.worker.sweep();
      await h.worker.sweep();
      await h.worker.sweep();
      expect(h.state.documents.get(documentId)).toMatchObject({ status: "failed" });
      expect(h.state.documents.get(documentId)?.attempts).toBeGreaterThanOrEqual(3);
      return { documentId, jobId: uploaded.body.job.id as string };
    };
    const reparse = (app: TestApp, documentId: string, companyId: string = COMPANY) =>
      request(app).post(`${companyPath(companyId)}/documents/${documentId}/reparse`);

    it("queues the stored bytes again with the attempts cleared, and the next pass makes it ready", async () => {
      const h = enabled();
      h.seedDataset();
      const app = h.app();
      const { documentId, jobId } = await failedDocument(h, app);
      const parsedBytes: string[] = [];
      h.ports.parser.parse = async (input) => {
        parsedBytes.push(Buffer.from(input.bytes).toString("utf8"));
        return { text: "a big book", chunks: [{ index: 0, text: "a big book" }] };
      };
      const blobsBefore = [...h.state.blobs.keys()];

      const response = await reparse(app, documentId);

      expect(response.status).toBe(202);
      expect(response.body.document).toMatchObject({ id: documentId, status: "queued", error: null, attempts: 0, chunkCount: 0 });
      expect(response.body.job).toMatchObject({ id: jobId, state: "queued", attempts: 0, lastError: null });
      expect(response.body.document.blobRef).toBeUndefined(); // never leaves the board
      // The same job and the same bytes: nothing was uploaded, nothing was duplicated.
      expect(h.state.jobs.size).toBe(1);
      expect([...h.state.blobs.keys()]).toEqual(blobsBefore);
      expect(h.audit.map((row) => row.action)).toEqual([CORPUS_DOCUMENT_UPLOADED_ACTION, CORPUS_DOCUMENT_REPARSED_ACTION]);
      expect(h.audit[1].details).toMatchObject({ datasetId: DATASET_ID, filename: "book.pdf", jobId });
      expect(String(h.audit[1].details.previousError)).toContain("502");

      expect(await h.worker.sweep()).toMatchObject({ claimed: 1, parsed: 1, failed: 0 });
      expect(parsedBytes).toEqual(["a big book"]);
      expect((await request(app).get(`${companyPath()}/documents/${documentId}`)).body.document).toMatchObject({
        status: "ready",
        chunkCount: 1,
        error: null,
      });
    });

    it("gives a document that fails again the full number of attempts once more", async () => {
      const h = enabled();
      h.seedDataset();
      const app = h.app();
      const { documentId } = await failedDocument(h, app);

      expect((await reparse(app, documentId)).status).toBe(202);
      expect(await h.worker.sweep()).toMatchObject({ claimed: 1, requeued: 1 });
      expect(await h.worker.sweep()).toMatchObject({ claimed: 1, requeued: 1 });
      expect(await h.worker.sweep()).toMatchObject({ claimed: 1, failed: 1 });
      expect(h.state.documents.get(documentId)?.status).toBe("failed");
      expect((await reparse(app, documentId)).status).toBe(202); // and again, as often as needed
    });

    it("refuses a document that is not failed, one without stored bytes and an unknown one", async () => {
      const h = enabled();
      h.seedDataset();
      const app = h.app();
      const queued = (await upload(app, DATASET_ID, "waiting", "waiting.txt")).body.document.id as string;
      const refusedQueued = await reparse(app, queued);
      expect(refusedQueued.status).toBe(409);
      expect(refusedQueued.body).toMatchObject({ error: "document_not_failed", status: "queued" });

      await h.worker.sweep();
      const refusedReady = await reparse(app, queued);
      expect(refusedReady.status).toBe(409);
      expect(refusedReady.body).toMatchObject({ error: "document_not_failed", status: "ready" });

      // A document that failed at upload (no embedder) never got its bytes.
      h.state.embedderConfigured = false;
      const noBytes = (await upload(app, DATASET_ID, "no embedder", "none.txt")).body.documentId as string;
      h.state.embedderConfigured = true;
      expect(h.state.documents.get(noBytes)).toMatchObject({ status: "failed", blobRef: "" });
      const refusedNoBytes = await reparse(app, noBytes);
      expect(refusedNoBytes.status).toBe(409);
      expect(refusedNoBytes.body.error).toBe("document_has_no_stored_bytes");

      expect((await reparse(app, "no-such-document")).status).toBe(404);
      expect(h.audit.map((row) => row.action)).not.toContain(CORPUS_DOCUMENT_REPARSED_ACTION);
    });

    it("keeps the company scope: another company's document is not reachable", async () => {
      const h = enabled();
      h.seedDataset();
      const app = h.app();
      const { documentId } = await failedDocument(h, app);

      expect((await reparse(h.app(strangerActor), documentId)).status).toBe(403);
      expect((await reparse(app, documentId, OTHER_COMPANY)).status).toBe(403);
      expect(h.state.documents.get(documentId)?.status).toBe("failed");
    });

    it("leaves the document failed while the embedder is still not configured", async () => {
      const h = enabled();
      h.seedDataset();
      const app = h.app();
      const { documentId } = await failedDocument(h, app);
      h.state.embedderConfigured = false;

      const response = await reparse(app, documentId);

      expect(response.status).toBe(422);
      expect(response.body.error).toBe("corpus_embedder_not_configured");
      expect(h.state.documents.get(documentId)).toMatchObject({ status: "failed" });
      expect(h.state.jobs.size).toBe(1);
      expect([...h.state.jobs.values()][0]?.state).toBe("failed");
    });

    it("puts the document back to failed when the job cannot be queued", async () => {
      const h = enabled();
      h.seedDataset();
      const app = h.app();
      const { documentId } = await failedDocument(h, app);
      h.ports.queue.enqueue = async () => {
        throw new Error("the queue is down");
      };

      const response = await reparse(app, documentId);

      expect(response.status).toBe(502);
      expect(response.body.error).toBe("enqueue_failed");
      const document = h.state.documents.get(documentId);
      expect(document).toMatchObject({ status: "failed" });
      expect(document?.error).toContain("502"); // the reason it had before is not lost
    });
  });
});

// myrmidon(1.6.6 OPE-12000): documents added by address and kept current. The pages are served by a
// stand-in transport behind the real URL fetcher, so the redirect, size and status handling run for
// real; the address guard is the board's own (`guardedRemoteHttpFetch`) and is exercised un-stubbed
// by the private-address cases — they never reach a socket.
describe("corpus API: documents by address, refreshed on a schedule", () => {
  type TestApp = ReturnType<typeof express>;

  const PAGE = "https://docs.example.com/guide/start";
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

  interface Page {
    status?: number;
    body?: string;
    type?: string;
    headers?: Record<string, string>;
  }

  /** A site: URL -> page, with the number of times each URL was asked for. */
  function site(pages: Record<string, Page>) {
    const hits = new Map<string, number>();
    const transport = async (url: URL): Promise<globalThis.Response> => {
      const key = url.toString();
      hits.set(key, (hits.get(key) ?? 0) + 1);
      const page = pages[key];
      if (!page) return new globalThis.Response("not found", { status: 404 });
      return new globalThis.Response(page.body ?? "", {
        status: page.status ?? 200,
        headers: { "content-type": page.type ?? "text/html; charset=utf-8", ...(page.headers ?? {}) },
      });
    };
    return {
      pages,
      transport,
      fetches: () => [...hits.values()].reduce((total, value) => total + value, 0),
      hitsOf: (url: string) => hits.get(url) ?? 0,
    };
  }

  const enabledEnv = {
    MYRMIDON_CORPUS_ENABLED: "true",
    MYRMIDON_CORPUS_PARSER_BASE_URL: "http://parser:8080",
  };

  function withSite(pages: Record<string, Page>, env: Record<string, string> = {}) {
    const web = site(pages);
    const fetchUrl = createCorpusUrlFetcher({ lookup: publicLookup, transport: web.transport });
    const h = corpusHarness({ env: { ...enabledEnv, ...env }, fetchUrl });
    h.seedDataset();
    return { h, web, fetchUrl, app: h.app() };
  }

  const addByUrl = (app: TestApp, body: Record<string, unknown>, datasetId: string = DATASET_ID) =>
    request(app).post(`${companyPath()}/datasets/${datasetId}/documents/url`).send(body);
  const refreshUrls = (app: TestApp, datasetId: string = DATASET_ID) =>
    request(app).post(`${companyPath()}/datasets/${datasetId}/refresh-urls`).send({});

  it("downloads the page, stores it like an upload and queues its parse", async () => {
    const { h, web, app } = withSite({ [PAGE]: { body: "<h1>Start</h1> install it" } });

    const response = await addByUrl(app, { url: PAGE, refreshIntervalHours: 24 });

    expect(response.status).toBe(202);
    expect(response.body.document).toMatchObject({
      status: "queued",
      filename: "docs.example.com_guide_start.html",
      mimeType: "text/html",
      byteSize: Buffer.byteLength("<h1>Start</h1> install it"),
      sourceUrl: PAGE,
      refreshIntervalHours: 24,
      contentHash: sha256Hex(Buffer.from("<h1>Start</h1> install it")),
      sourceError: null,
    });
    expect(response.body.document.lastFetchedAt).toEqual(expect.any(String));
    expect(response.body.job).toMatchObject({ state: "queued", attempts: 0 });
    // The same road an upload takes: bytes in the BlobStore, one job, nothing indexed yet.
    expect(web.hitsOf(PAGE)).toBe(1);
    expect(h.state.blobs.size).toBe(1);
    expect(h.state.jobs.size).toBe(1);
    expect(h.state.chunks.size).toBe(0);
    expect(h.audit.map((row) => row.action)).toEqual([CORPUS_DOCUMENT_UPLOADED_ACTION]);
    expect(h.audit[0].details).toMatchObject({ sourceUrl: PAGE, refreshIntervalHours: 24 });

    // And the parse worker takes it to ready like any other document.
    await h.worker.sweep();
    expect([...h.state.documents.values()][0]).toMatchObject({ status: "ready", chunkCount: 1 });
  });

  it("refreshes once a week unless told otherwise, and takes the caller's name", async () => {
    const { app } = withSite({ [PAGE]: { body: "x" } });

    const response = await addByUrl(app, { url: PAGE, name: "Start guide.html" });

    expect(response.status).toBe(202);
    expect(response.body.document).toMatchObject({ filename: "Start guide.html", refreshIntervalHours: 168 });
  });

  it("refuses the same address twice in one dataset", async () => {
    const { h, app } = withSite({ [PAGE]: { body: "x" } });
    const first = await addByUrl(app, { url: PAGE });

    const second = await addByUrl(app, { url: PAGE });

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "source_url_exists", documentId: first.body.document.id });
    expect(h.state.documents.size).toBe(1);
  });

  it("keeps the hash and does not parse again when the page has not changed", async () => {
    const { h, web, app } = withSite({ [PAGE]: { body: "same words" } });
    const added = await addByUrl(app, { url: PAGE });
    await h.worker.sweep();
    expect(h.calls.parse).toBe(1);
    const blobRefBefore = h.state.documents.get(added.body.document.id)?.blobRef;

    const refreshed = await refreshUrls(app);

    expect(refreshed.status).toBe(202);
    expect(refreshed.body).toMatchObject({
      datasetId: DATASET_ID,
      checked: 1,
      unchanged: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(web.hitsOf(PAGE)).toBe(2); // the page was asked for again...
    await h.worker.sweep();
    expect(h.calls.parse).toBe(1); // ...and nothing was parsed again
    expect(h.calls.index).toBe(1);
    const document = h.state.documents.get(added.body.document.id);
    expect(document).toMatchObject({ status: "ready", chunkCount: 1, blobRef: blobRefBefore });
    expect(h.state.blobs.size).toBe(1);
    expect(h.audit.map((row) => row.action)).not.toContain(CORPUS_DOCUMENT_REFRESHED_ACTION);
  });

  it("replaces the content and parses again when the page has changed", async () => {
    const { h, web, app } = withSite({ [PAGE]: { body: "old words" } });
    const added = await addByUrl(app, { url: PAGE });
    const documentId = added.body.document.id as string;
    await h.worker.sweep();
    const oldRef = h.state.documents.get(documentId)!.blobRef;
    expect(h.state.chunks.get(documentId)?.[0]?.text).toBe("hello corpus");
    const deletesBefore = h.calls.indexDelete;

    web.pages[PAGE] = { body: "brand new words, longer" };
    h.state.parse = { text: "fresh chunk", chunks: [{ index: 0, text: "fresh chunk" }] };
    const refreshed = await refreshUrls(app);

    expect(refreshed.status).toBe(202);
    expect(refreshed.body).toMatchObject({ checked: 1, unchanged: 0, updated: 1, failed: 0 });
    // The stored version is the new one, waiting for its parse; the old chunks and bytes are gone.
    const queued = h.state.documents.get(documentId)!;
    expect(queued).toMatchObject({
      status: "queued",
      chunkCount: 0,
      error: null,
      attempts: 0,
      byteSize: Buffer.byteLength("brand new words, longer"),
      contentHash: sha256Hex(Buffer.from("brand new words, longer")),
    });
    expect(queued.blobRef).not.toBe(oldRef);
    expect(h.state.blobs.has(oldRef)).toBe(false);
    expect(Buffer.from(h.state.blobs.get(queued.blobRef)!).toString("utf8")).toBe("brand new words, longer");
    expect(h.calls.indexDelete).toBe(deletesBefore + 1);
    expect(h.state.chunks.has(documentId)).toBe(false);
    expect([...h.state.jobs.values()].filter((job) => job.documentId === documentId)).toEqual([
      expect.objectContaining({ state: "queued", attempts: 0 }),
    ]);
    expect(h.audit.at(-1)).toMatchObject({
      action: CORPUS_DOCUMENT_REFRESHED_ACTION,
      entityId: documentId,
      details: { sourceUrl: PAGE, contentHash: queued.contentHash },
    });

    // The next parse pass writes the new version.
    await h.worker.sweep();
    expect(h.calls.parse).toBe(2);
    expect(h.state.documents.get(documentId)).toMatchObject({ status: "ready", chunkCount: 1 });
    expect(h.state.chunks.get(documentId)?.[0]?.text).toBe("fresh chunk");
  });

  it("keeps the stored version and says why when a fetch fails", async () => {
    const { h, web, app } = withSite({ [PAGE]: { body: "good words" } });
    const added = await addByUrl(app, { url: PAGE });
    const documentId = added.body.document.id as string;
    await h.worker.sweep();

    web.pages[PAGE] = { status: 503, body: "down" };
    const refreshed = await refreshUrls(app);

    expect(refreshed.body).toMatchObject({ checked: 1, updated: 0, failed: 1 });
    expect(refreshed.body.failures).toEqual([
      { documentId, sourceUrl: PAGE, error: expect.stringContaining("503") },
    ]);
    const document = await request(app).get(`${companyPath()}/documents/${documentId}`);
    expect(document.body.document).toMatchObject({ status: "ready", chunkCount: 1 });
    expect(document.body.document.sourceError).toContain("503");
    expect(h.state.chunks.has(documentId)).toBe(true);

    // The next good answer clears the note.
    web.pages[PAGE] = { body: "good words" };
    await refreshUrls(app);
    const recovered = await request(app).get(`${companyPath()}/documents/${documentId}`);
    expect(recovered.body.document.sourceError).toBeNull();
  });

  it("leaves a document that is still being parsed alone", async () => {
    const { h, web, app } = withSite({ [PAGE]: { body: "first" } });
    await addByUrl(app, { url: PAGE });
    web.pages[PAGE] = { body: "second" };

    const refreshed = await refreshUrls(app); // the document is still queued

    expect(refreshed.body).toMatchObject({ checked: 1, skipped: 1, updated: 0, unchanged: 0, failed: 0 });
    expect(web.hitsOf(PAGE)).toBe(1);
    expect(h.state.blobs.size).toBe(1);
  });

  it("follows a redirect to a public page and stores the page it landed on", async () => {
    const moved = "https://docs.example.com/guide/moved";
    const { h, app } = withSite({
      [PAGE]: { status: 301, headers: { location: "/guide/moved" } },
      [moved]: { body: "landed", type: "text/plain" },
    });

    const response = await addByUrl(app, { url: PAGE, name: "moved.txt" });

    expect(response.status).toBe(202);
    expect(response.body.document).toMatchObject({ sourceUrl: PAGE, mimeType: "text/plain", byteSize: 6 });
    expect(Buffer.from([...h.state.blobs.values()][0]!).toString("utf8")).toBe("landed");
  });

  it("refuses an oversized page, an empty one and an error status without creating a document", async () => {
    const { h, app } = withSite(
      {
        "https://docs.example.com/big": { body: "x".repeat(2_048), headers: { "content-length": "2048" } },
        "https://docs.example.com/empty": { body: "" },
        "https://docs.example.com/gone": { status: 404, body: "no" },
      },
      { MYRMIDON_CORPUS_MAX_DOCUMENT_BYTES: "1024" },
    );

    const big = await addByUrl(app, { url: "https://docs.example.com/big" });
    const empty = await addByUrl(app, { url: "https://docs.example.com/empty" });
    const gone = await addByUrl(app, { url: "https://docs.example.com/gone" });

    expect(big.status).toBe(413);
    expect(big.body.error).toBe("document_too_large");
    expect(empty.status).toBe(422);
    expect(empty.body.error).toBe("empty_document");
    expect(gone.status).toBe(502);
    expect(gone.body).toMatchObject({ error: "source_fetch_failed", upstreamStatus: 404 });
    expect(h.state.documents.size).toBe(0);
    expect(h.state.blobs.size).toBe(0);
  });

  describe("addresses that must never be fetched", () => {
    // No stand-in transport here: the real guard decides, and it decides before any socket opens.
    it.each([
      ["a loopback address", "http://127.0.0.1:3100/api/health", "source_url_blocked"],
      ["a private network address", "http://10.0.0.5/admin", "source_url_blocked"],
      ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/", "source_url_blocked"],
      ["an IPv6 loopback", "http://[::1]/", "source_url_blocked"],
      ["an IPv4-mapped IPv6 loopback", "http://[::ffff:7f00:1]/", "source_url_blocked"],
      ["localhost", "http://localhost:3100/api/companies", "source_url_blocked"],
      ["a file address", "file:///etc/passwd", "source_url_invalid"],
      ["an ftp address", "ftp://example.com/doc.pdf", "source_url_invalid"],
      ["an address with a password", "https://user:secret@example.com/doc", "source_url_invalid"],
      ["not a URL", "docs.example.com/guide", "source_url_invalid"],
    ])("refuses %s", async (_label, url, code) => {
      const h = corpusHarness({ env: enabledEnv });
      h.seedDataset();

      const response = await addByUrl(h.app(), { url });

      expect(response.status).toBe(422);
      expect(response.body.error).toBe(code);
      expect(h.state.documents.size).toBe(0);
      expect(h.state.blobs.size).toBe(0);
      expect(h.state.jobs.size).toBe(0);
      expect(h.audit).toEqual([]);
    });

    it("refuses a host name that resolves to a private address", async () => {
      const fetchUrl = createCorpusUrlFetcher({ lookup: async () => [{ address: "10.1.2.3", family: 4 }] });
      const h = corpusHarness({ env: enabledEnv, fetchUrl });
      h.seedDataset();

      const response = await addByUrl(h.app(), { url: "https://internal.example.com/wiki" });

      expect(response.status).toBe(422);
      expect(response.body.error).toBe("source_url_blocked");
      expect(h.state.documents.size).toBe(0);
    });

    it("refuses a redirect that leads to a private address", async () => {
      // First hop: a public page that redirects. Second hop: the real guard, which says no.
      const transport = (url: URL, init: RequestInit, options: Parameters<typeof guardedRemoteHttpFetch>[2]) =>
        url.hostname === "docs.example.com"
          ? Promise.resolve(new globalThis.Response(null, { status: 302, headers: { location: "http://127.0.0.1:3100/api/health" } }))
          : guardedRemoteHttpFetch(url, init, options);
      const fetchUrl = createCorpusUrlFetcher({ lookup: publicLookup, transport });
      const h = corpusHarness({ env: enabledEnv, fetchUrl });
      h.seedDataset();

      const response = await addByUrl(h.app(), { url: PAGE });

      expect(response.status).toBe(422);
      expect(response.body.error).toBe("source_url_blocked");
      expect(h.state.documents.size).toBe(0);
    });

    it("never refreshes a stored address that has become private", async () => {
      const web = site({ [PAGE]: { body: "x" } });
      // First the address is public and served; later its host name resolves to a private network.
      let active = createCorpusUrlFetcher({ lookup: publicLookup, transport: web.transport });
      const h = corpusHarness({ env: enabledEnv, fetchUrl: (url, limits) => active(url, limits) });
      h.seedDataset();
      const app = h.app();
      await addByUrl(app, { url: PAGE });
      await h.worker.sweep();
      expect(web.fetches()).toBe(1);

      active = createCorpusUrlFetcher({ lookup: async () => [{ address: "192.168.1.9", family: 4 }] });
      const refreshed = await refreshUrls(app);

      expect(refreshed.body).toMatchObject({ checked: 1, failed: 1, updated: 0 });
      expect(refreshed.body.failures[0].error).toContain("private");
      expect(web.fetches()).toBe(1);
      expect([...h.state.documents.values()][0]).toMatchObject({ status: "ready", chunkCount: 1 });
    });
  });

  it("answers 503 while the module is off and 403 across companies, without fetching anything", async () => {
    const web = site({ [PAGE]: { body: "x" } });
    const fetchUrl = createCorpusUrlFetcher({ lookup: publicLookup, transport: web.transport });
    const off = corpusHarness({ fetchUrl });
    off.seedDataset();
    const disabled = await addByUrl(off.app(), { url: PAGE });
    expect(disabled.status).toBe(503);
    expect(disabled.body.error).toBe("corpus_disabled");
    expect((await refreshUrls(off.app())).status).toBe(503);

    const on = corpusHarness({ env: enabledEnv, fetchUrl });
    on.seedDataset();
    expect((await addByUrl(on.app(strangerActor), { url: PAGE })).status).toBe(403);
    expect((await refreshUrls(on.app(strangerActor))).status).toBe(403);
    expect((await addByUrl(on.app(), { url: PAGE }, "99999999-9999-4999-8999-999999999999")).status).toBe(404);
    expect(web.fetches()).toBe(0);
  });

  it("validates the body", async () => {
    const { app } = withSite({});

    expect((await addByUrl(app, {})).status).toBe(400);
    expect((await addByUrl(app, { url: PAGE, refreshIntervalHours: 0 })).status).toBe(400);
    expect((await addByUrl(app, { url: PAGE, refreshIntervalHours: 1.5 })).status).toBe(400);
    expect((await addByUrl(app, { url: PAGE, extra: true })).status).toBe(400);
  });

  describe("the scheduled sweep", () => {
    const hours = (n: number) => n * 3_600_000;

    function sweeper(h: ReturnType<typeof corpusHarness>, fetchUrl: ReturnType<typeof createCorpusUrlFetcher>, offsetMs: number) {
      return createCorpusSourceRefresher({
        ports: h.deps.ports,
        resolveSettings: async () => {
          const view = await h.service.readSettings();
          return { settings: view.settings, enabled: view.enabled };
        },
        fetcher: fetchUrl,
        now: () => new Date(Date.now() + offsetMs),
        onUpdated: async (document, outcome) => {
          h.audit.push({
            action: CORPUS_DOCUMENT_REFRESHED_ACTION,
            companyId: document.companyId,
            entityType: "corpus_document",
            entityId: document.id,
            details: { contentHash: outcome.contentHash },
          });
        },
      });
    }

    it("fetches only the documents whose interval has passed", async () => {
      const { h, web, fetchUrl, app } = withSite({
        [PAGE]: { body: "daily" },
        "https://docs.example.com/weekly": { body: "weekly" },
      });
      await addByUrl(app, { url: PAGE, refreshIntervalHours: 24 });
      await addByUrl(app, { url: "https://docs.example.com/weekly" }); // 168 h
      await h.worker.sweep();
      expect(web.fetches()).toBe(2);

      const early = await sweeper(h, fetchUrl, hours(23)).sweep();
      expect(early).toMatchObject({ enabled: true, available: true, checked: 0 });
      expect(web.fetches()).toBe(2);

      web.pages[PAGE] = { body: "daily, changed" };
      const nextDay = await sweeper(h, fetchUrl, hours(25)).sweep();
      expect(nextDay).toMatchObject({ checked: 1, updated: 1, unchanged: 0, failed: 0 });
      expect(web.hitsOf(PAGE)).toBe(2);
      expect(web.hitsOf("https://docs.example.com/weekly")).toBe(1);

      // After a week both are due again, and neither page has moved since.
      await h.worker.sweep(); // the changed daily page is parsed
      const nextWeek = await sweeper(h, fetchUrl, hours(24 * 8)).sweep();
      expect(nextWeek).toMatchObject({ checked: 2, unchanged: 2, updated: 0, skipped: 0, failed: 0 });
    });

    it("is silent while the module is off or unwired", async () => {
      const web = site({ [PAGE]: { body: "x" } });
      const fetchUrl = createCorpusUrlFetcher({ lookup: publicLookup, transport: web.transport });

      const off = corpusHarness({ fetchUrl });
      off.seedDataset();
      expect(await sweeper(off, fetchUrl, hours(1000)).sweep()).toMatchObject({ enabled: false, available: false, checked: 0 });
      expect(off.calls.resolvePorts).toBe(0);

      const unwired = corpusHarness({ env: enabledEnv, fetchUrl, wired: false });
      expect(await sweeper(unwired, fetchUrl, hours(1000)).sweep()).toMatchObject({ enabled: true, available: false, checked: 0 });
      expect(web.fetches()).toBe(0);
    });

    it("does not touch uploads or documents whose source address was only provenance", async () => {
      const { h, web, fetchUrl, app } = withSite({});
      await request(app)
        .post(`${companyPath()}/datasets/${DATASET_ID}/documents`)
        .attach("file", Buffer.from("uploaded"), { filename: "notes.txt", contentType: "text/plain" });
      expect([...h.state.documents.values()][0]?.sourceUrl).toBeNull();

      const result = await sweeper(h, fetchUrl, hours(24 * 365)).sweep();

      expect(result.checked).toBe(0);
      expect(web.fetches()).toBe(0);
    });
  });
});
