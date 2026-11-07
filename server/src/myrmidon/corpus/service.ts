// server/src/myrmidon/corpus/service.ts
//
// myrmidon(1.6.6 CORPUS-2.0 ч.C): the corpus management service — datasets,
// documents, parse jobs, search and the module settings, all over the five
// ports of `packages/corpus` (see ./ports.ts, a local copy until part A merges).
//
// Settings precedence is the shared one (CONVENTIONS.md §8): the stored
// `instance_settings.general.corpus` block is the truth once an operator saves
// it, the environment is the default, every key has a built-in default. The
// block is written on the same transition queue as the runtime limits, so the
// activity log and the values in force cannot disagree (see
// ../runtime-limits/service.ts for the reasoning).
//
// The module is OFF by default and stays silent: while `enabled` is false the
// data methods throw `corpus_disabled` BEFORE they touch a port (the ports
// resolver is not even called — nothing opens a connection, nothing is queued),
// and while the ports are not wired they throw `corpus_not_configured`. Both are
// 503 for the routes; neither changes anything else on the board.

import type { Db } from "@myrmidon/db";
import {
  CORPUS_DEFAULT_REFRESH_INTERVAL_HOURS,
  CORPUS_DISABLED_ERROR,
  changedCorpusSettingsKeys,
  mergeCorpusSettings,
  resolveCorpusSettings,
  type CorpusDataset,
  type CorpusDocument,
  type CorpusParseJob,
  type CorpusRefreshUrlsStarted,
  type CorpusSearchHit,
  type CorpusSearchMode,
  type CorpusSearchResponse,
  type CorpusSettings,
  type CorpusSettingsPatch,
  type CorpusStats,
  type ResolvedCorpusSettings,
} from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import type {
  CorpusDocumentRecord,
  CorpusDatasetRecord,
  CorpusJobRecord,
  CorpusPorts,
  CorpusPortsResolver,
  ParsedChunk,
} from "./ports.js";
import {
  CorpusSourceError,
  createCorpusUrlFetcher,
  defaultSourceName,
  parseCorpusSourceUrl,
  type CorpusUrlFetcher,
} from "./source-fetch.js";
import { refreshSourceDocuments } from "./source.js";

/** `instance.corpus.settings_updated` — the audit action of a settings change. */
export const CORPUS_SETTINGS_ACTION = "instance.corpus.settings_updated";
/** `myrmidon.corpus.document_uploaded` / `…document_reparsed` / `…document_deleted` / `…dataset_deleted`. */
export const CORPUS_DOCUMENT_UPLOADED_ACTION = "myrmidon.corpus.document_uploaded";
export const CORPUS_DOCUMENT_REPARSED_ACTION = "myrmidon.corpus.document_reparsed";
export const CORPUS_DOCUMENT_DELETED_ACTION = "myrmidon.corpus.document_deleted";
/** OPE-12000: a URL-sourced document got new content (an unchanged refresh is not audited). */
export const CORPUS_DOCUMENT_REFRESHED_ACTION = "myrmidon.corpus.document_refreshed";
/** OPE-12000: a manual refresh of a dataset's URL documents began / ended (the end carries the counters). */
export const CORPUS_REFRESH_STARTED_ACTION = "myrmidon.corpus.refresh_started";
export const CORPUS_REFRESH_COMPLETED_ACTION = "myrmidon.corpus.refresh_completed";
/** Least time between the end of one manual refresh of a dataset and the start of the next. */
export const CORPUS_REFRESH_PAUSE_MS = 60_000;
export const CORPUS_DATASET_DELETED_ACTION = "myrmidon.corpus.dataset_deleted";

/** Code of the 503 a data route answers while the ports of parts A/B are missing. */
export const CORPUS_NOT_CONFIGURED_ERROR = "corpus_not_configured";
export const CORPUS_EMBEDDER_NOT_CONFIGURED_ERROR = "corpus_embedder_not_configured";

/** Who called the route, for the activity log (same shape as the runtime limits). */
export interface CorpusActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export type CorpusAuditEntry = CorpusActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/**
 * A refusal the route turns into an HTTP answer. `code` is a machine token
 * (`corpus_disabled`, `not_found`, `document_too_large`, …) the UI switches on;
 * a plain `Error` is a bug and keeps the vendor 500 path.
 */
export class CorpusRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CorpusRequestError";
  }
}

/** The settings view: the values, their source, and whether the ports are wired. */
export type CorpusSettingsView = ResolvedCorpusSettings & {
  /** False while this process has no ports (parts A/B not merged/wired yet). */
  available: boolean;
};

export interface CorpusServiceDeps {
  settings: {
    getGeneral(): Promise<{ corpus?: unknown }>;
    updateGeneral(patch: { corpus: CorpusSettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: CorpusAuditEntry): Promise<unknown>;
  /** Builds the ports of one call, or `null` when this process cannot serve the corpus. */
  ports: CorpusPortsResolver;
  env?: Record<string, string | undefined>;
  /** OPE-12000: downloads a document by address; the guarded fetcher unless a test supplies one. */
  fetchUrl?: CorpusUrlFetcher;
  /** Milliseconds clock; tests move it to step over the pause between manual refreshes. */
  now?: () => number;
}

export interface CorpusUploadInput {
  companyId: string;
  datasetId: string;
  filename: string;
  mimeType: string | null;
  bytes: Uint8Array;
  actor: CorpusActor;
}

/** OPE-12000: a document added by address instead of uploaded. */
export interface CorpusAddUrlInput {
  companyId: string;
  datasetId: string;
  url: string;
  refreshIntervalHours?: number;
  name?: string;
  actor: CorpusActor;
}

export interface CorpusUploadResult {
  document: CorpusDocument;
  job: CorpusParseJob;
}

export interface CorpusService {
  readSettings(): Promise<CorpusSettingsView>;
  updateSettings(patch: CorpusSettingsPatch, actor: CorpusActor): Promise<CorpusSettingsView>;
  listDatasets(companyId: string): Promise<CorpusDataset[]>;
  createDataset(
    companyId: string,
    input: { name: string; description?: string | null },
    actor: CorpusActor,
  ): Promise<CorpusDataset>;
  getDataset(companyId: string, datasetId: string): Promise<CorpusDataset>;
  updateDataset(
    companyId: string,
    datasetId: string,
    patch: { name?: string; description?: string | null },
    actor: CorpusActor,
  ): Promise<CorpusDataset>;
  deleteDataset(companyId: string, datasetId: string, actor: CorpusActor): Promise<void>;
  listDocuments(
    companyId: string,
    datasetId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<CorpusDocument[]>;
  uploadDocument(input: CorpusUploadInput): Promise<CorpusUploadResult>;
  /**
   * OPE-12000: downloads `url` (http/https, public addresses only, `maxDocumentBytes` ceiling),
   * stores it as a document of the dataset on the road an upload takes, queues its parse, and
   * remembers the address and the refresh interval so the scheduled sweep keeps it current.
   */
  addDocumentFromUrl(input: CorpusAddUrlInput): Promise<CorpusUploadResult>;
  /**
   * OPE-12000: starts fetching every URL-sourced document of the dataset now, whatever its interval,
   * and returns at once; the run goes on in the background and its counters are audited when it ends.
   * Refused with 409 `refresh_in_progress` while a run of the dataset is going, and with 429
   * `refresh_too_soon` within CORPUS_REFRESH_PAUSE_MS of the end of the last one.
   */
  refreshDatasetUrls(companyId: string, datasetId: string, actor: CorpusActor): Promise<CorpusRefreshUrlsStarted>;
  getDocument(companyId: string, documentId: string): Promise<CorpusDocument>;
  /**
   * Parses a failed document again from the bytes already stored: the document goes back to
   * `queued` with its error cleared and its job starts over with no attempts used. Refused (409)
   * for a document that is not `failed` or has no stored bytes.
   */
  reparseDocument(companyId: string, documentId: string, actor: CorpusActor): Promise<CorpusUploadResult>;
  deleteDocument(companyId: string, documentId: string, actor: CorpusActor): Promise<void>;
  getJob(companyId: string, jobId: string): Promise<CorpusParseJob>;
  search(
    companyId: string,
    datasetId: string,
    input: { query: string; limit?: number; mode?: CorpusSearchMode },
  ): Promise<CorpusSearchResponse>;
  stats(companyId: string): Promise<CorpusStats>;
}

function toDataset(record: CorpusDatasetRecord): CorpusDataset {
  return { ...record };
}

function toDocument(record: CorpusDocumentRecord): CorpusDocument {
  // Explicit mapping, not a spread: the wire contract of this part owns the
  // field list (the store record keeps `blobRef`, which never leaves the board).
  return {
    id: record.id,
    companyId: record.companyId,
    datasetId: record.datasetId,
    filename: record.filename,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
    status: record.status,
    chunkCount: record.chunkCount,
    error: record.error,
    attempts: record.attempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    parsedAt: record.parsedAt,
    sourceUrl: record.sourceUrl ?? null,
    refreshIntervalHours: record.refreshIntervalHours ?? null,
    contentHash: record.contentHash ?? null,
    lastFetchedAt: record.lastFetchedAt ?? null,
    sourceError: record.sourceError ?? null,
  };
}

function toJob(record: CorpusJobRecord): CorpusParseJob {
  return { ...record };
}

let corpusTransitionQueue: Promise<void> = Promise.resolve();

function withCorpusTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = corpusTransitionQueue.then(run);
  corpusTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function corpusService(db: Db, overrides: Partial<CorpusServiceDeps> = {}): CorpusService {
  const deps: CorpusServiceDeps = {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    // No ports by default: a process that does not wire the corpus serves it as
    // "enabled but not configured" instead of guessing a database half.
    ports: () => null,
    ...overrides,
  };
  const fetchUrl: CorpusUrlFetcher = deps.fetchUrl ?? createCorpusUrlFetcher();
  const now = deps.now ?? Date.now;
  // Per process, like the rest of the module's in-memory state: which datasets are being refreshed,
  // when each was last done, and the per-address lock of add-by-address.
  const refreshRunning = new Set<string>();
  const refreshFinishedAt = new Map<string, number>();
  const keyedLocks = new Map<string, Promise<void>>();

  async function withKeyedLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = keyedLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => mine);
    keyedLocks.set(key, tail);
    await before;
    try {
      return await run();
    } finally {
      release();
      if (keyedLocks.get(key) === tail) keyedLocks.delete(key);
    }
  }
  const env = deps.env ?? process.env;

  function notFound(what: string): CorpusRequestError {
    return new CorpusRequestError(404, "not_found", `${what} not found`);
  }

  async function readSettings(): Promise<CorpusSettingsView> {
    const general = await deps.settings.getGeneral();
    const resolved = resolveCorpusSettings({ stored: general.corpus, env });
    // The resolver is only asked while the module is on: a disabled module must
    // not open a connection just to answer the settings page.
    const available =
      resolved.enabled && deps.ports({ env, settings: resolved.settings }) !== null;
    return { ...resolved, available };
  }

  /** The settings in force plus the ports of this call, or the 503 that says why not. */
  async function requirePorts(): Promise<{ settings: CorpusSettings; ports: CorpusPorts }> {
    const general = await deps.settings.getGeneral();
    const resolved = resolveCorpusSettings({ stored: general.corpus, env });
    if (!resolved.enabled) {
      throw new CorpusRequestError(503, CORPUS_DISABLED_ERROR, "the corpus module is disabled", {
        enabled: false,
      });
    }
    const ports = deps.ports({ env, settings: resolved.settings });
    if (!ports) {
      throw new CorpusRequestError(
        503,
        CORPUS_NOT_CONFIGURED_ERROR,
        "the corpus module is enabled but its ports are not wired in this process",
        { enabled: true },
      );
    }
    return { settings: resolved.settings, ports };
  }

  async function requireDataset(
    ports: CorpusPorts,
    companyId: string,
    datasetId: string,
  ): Promise<CorpusDatasetRecord> {
    const dataset = await ports.store.getDataset(companyId, datasetId);
    if (!dataset) throw notFound("dataset");
    return dataset;
  }

  /** One activity row; the database service fills in the entity fields. */
  async function audit(
    actor: CorpusActor,
    action: string,
    companyId: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await deps.logActivity({
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType,
      entityId,
      details,
    });
  }

  /** Turns the fetcher's refusal into the HTTP answer; anything else is a bug and stays one. */
  function sourceFailure(err: unknown): unknown {
    if (err instanceof CorpusSourceError) {
      return new CorpusRequestError(err.status, err.code, err.message, err.details);
    }
    return err;
  }

  function parseSourceUrl(value: string): URL {
    try {
      return parseCorpusSourceUrl(value);
    } catch (err) {
      throw sourceFailure(err);
    }
  }

  const ingestDocument = async ({
    companyId,
    datasetId,
    filename,
    mimeType,
    bytes,
    actor,
    source,
  }: CorpusUploadInput & { source?: NonNullable<Parameters<CorpusPorts["store"]["createDocument"]>[0]["source"]> }): Promise<CorpusUploadResult> => {
    const { settings, ports } = await requirePorts();
    await requireDataset(ports, companyId, datasetId);

    const name = filename.trim() || "document";
    if (bytes.byteLength === 0) {
      throw new CorpusRequestError(400, "empty_document", "the uploaded document is empty");
    }
    if (bytes.byteLength > settings.maxDocumentBytes) {
      throw new CorpusRequestError(
        413,
        "document_too_large",
        `the document exceeds maxDocumentBytes (${settings.maxDocumentBytes})`,
        { maxDocumentBytes: settings.maxDocumentBytes, byteSize: bytes.byteLength },
      );
    }
    const existing = await ports.store.countDocuments(companyId, datasetId);
    if (existing >= settings.maxDocumentsPerDataset) {
      throw new CorpusRequestError(
        409,
        "dataset_full",
        `the dataset already holds maxDocumentsPerDataset documents (${settings.maxDocumentsPerDataset})`,
        { maxDocumentsPerDataset: settings.maxDocumentsPerDataset },
      );
    }

    // The row is created first: the blob key is built from the document id, and
    // a document that never got its bytes stays visible (and deletable).
    let document = await ports.store.createDocument({
      companyId,
      datasetId,
      filename: name,
      mimeType,
      byteSize: bytes.byteLength,
      blobRef: "",
      maxAttempts: settings.maxParseAttempts,
      ...(source ? { source } : {}),
    });

    if (ports.index.assertEmbedderConfigured) {
      try {
        await ports.index.assertEmbedderConfigured(companyId, settings.embedderBaseUrl);
      } catch (err) {
        if (err instanceof CorpusRequestError && err.code === CORPUS_EMBEDDER_NOT_CONFIGURED_ERROR) {
          await ports.store.updateDocument(companyId, document.id, {
            status: "failed",
            error: err.code,
          });
          throw new CorpusRequestError(
            err.status,
            err.code,
            err.message,
            { ...err.details, documentId: document.id },
          );
        }
        throw err;
      }
    }

    try {
      const blob = await ports.blobs.put({
        companyId,
        documentId: document.id,
        filename: name,
        mimeType,
        bytes,
      });
      document =
        (await ports.store.updateDocument(companyId, document.id, {
          blobRef: blob.ref,
        })) ?? document;
    } catch (err) {
      logger.error(
        { err, companyId, datasetId, documentId: document.id },
        "corpus upload: the blob write failed, dropping the document",
      );
      await ports.store.deleteDocument(companyId, document.id).catch(() => undefined);
      throw new CorpusRequestError(502, "blob_write_failed", "the document bytes could not be stored");
    }

    let job: CorpusJobRecord;
    try {
      job = await ports.queue.enqueue({
        companyId,
        datasetId,
        documentId: document.id,
        maxAttempts: settings.maxParseAttempts,
      });
    } catch (err) {
      logger.error({ err, companyId, documentId: document.id }, "corpus upload: the enqueue failed");
      document =
        (await ports.store.updateDocument(companyId, document.id, {
          status: "failed",
          error: "queue_unavailable",
        })) ?? document;
      throw new CorpusRequestError(502, "enqueue_failed", "the document could not be queued for parsing");
    }

    await audit(actor, CORPUS_DOCUMENT_UPLOADED_ACTION, companyId, "corpus_document", document.id, {
      datasetId,
      filename: name,
      byteSize: document.byteSize,
      jobId: job.id,
      ...(source
        ? { sourceUrl: source.url, refreshIntervalHours: source.refreshIntervalHours, contentHash: source.contentHash }
        : {}),
    });
    return { document: toDocument(document), job: toJob(job) };
  };

  const updateSettings = (
    patch: CorpusSettingsPatch,
    actor: CorpusActor,
  ): Promise<CorpusSettingsView> =>
    withCorpusTransition(async () => {
      const general = await deps.settings.getGeneral();
      const before = resolveCorpusSettings({ stored: general.corpus, env });
      const next = mergeCorpusSettings(before.settings, patch);
      const changedKeys = changedCorpusSettingsKeys(before.settings, next);

      await deps.settings.updateGeneral({ corpus: next });

      if (changedKeys.length > 0) {
        const companyIds = await deps.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            deps.logActivity({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: CORPUS_SETTINGS_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before.settings, next, changedKeys },
            }),
          ),
        );
        logger.info(
          { changedKeys, enabled: next.enabled, actorType: actor.actorType },
          "corpus module settings updated without a restart",
        );
      }

      const resolved = resolveCorpusSettings({ stored: next, env });
      const available = next.enabled && deps.ports({ env, settings: next }) !== null;
      return { ...resolved, available };
    });

  return {
    readSettings,
    updateSettings,

    listDatasets: async (companyId) => {
      const { ports } = await requirePorts();
      const datasets = await ports.store.listDatasets(companyId);
      return datasets.map(toDataset);
    },

    createDataset: async (companyId, input, actor) => {
      const { ports } = await requirePorts();
      const name = input.name.trim();
      const dataset = await ports.store.createDataset({
        companyId,
        name,
        description: input.description?.trim() || null,
      });
      logger.info({ companyId, datasetId: dataset.id, actorType: actor.actorType }, "corpus dataset created");
      return toDataset(dataset);
    },

    getDataset: async (companyId, datasetId) => {
      const { ports } = await requirePorts();
      return toDataset(await requireDataset(ports, companyId, datasetId));
    },

    updateDataset: async (companyId, datasetId, patch, _actor) => {
      const { ports } = await requirePorts();
      await requireDataset(ports, companyId, datasetId);
      const next: { name?: string; description?: string | null } = {};
      if (patch.name !== undefined) next.name = patch.name.trim();
      if (patch.description !== undefined) next.description = patch.description?.trim() || null;
      // Only the keys the caller sent: a spread-style store would otherwise
      // wipe the stored description with an explicit `undefined`.
      const updated = await ports.store.updateDataset(companyId, datasetId, next);
      if (!updated) throw notFound("dataset");
      return toDataset(updated);
    },

    deleteDataset: async (companyId, datasetId, actor) => {
      const { ports } = await requirePorts();
      await requireDataset(ports, companyId, datasetId);
      // Best effort on the two derived stores: a leftover chunk or blob must not
      // keep the dataset alive, and the failure is visible in the log.
      for (;;) {
        const documents = await ports.store.listDocuments(companyId, datasetId, { limit: 200 });
        if (documents.length === 0) break;
        for (const document of documents) {
          await dropDerived(ports, document);
          await ports.store.deleteDocument(companyId, document.id);
        }
      }
      await ports.store.deleteDataset(companyId, datasetId);
      await audit(actor, CORPUS_DATASET_DELETED_ACTION, companyId, "corpus_dataset", datasetId, {
        datasetId,
      });
    },

    listDocuments: async (companyId, datasetId, options) => {
      const { ports } = await requirePorts();
      await requireDataset(ports, companyId, datasetId);
      const documents = await ports.store.listDocuments(companyId, datasetId, {
        limit: Math.min(Math.max(options?.limit ?? 100, 1), 500),
        offset: Math.max(options?.offset ?? 0, 0),
      });
      return documents.map(toDocument);
    },

    uploadDocument: (input) => ingestDocument(input),

    addDocumentFromUrl: async ({ companyId, datasetId, url, refreshIntervalHours, name, actor }) => {
      const { settings, ports } = await requirePorts();
      await requireDataset(ports, companyId, datasetId);

      const parsed = parseSourceUrl(url);
      const sourceUrl = parsed.toString();
      const assertNotThere = async (): Promise<void> => {
        const existing = await ports.store.listSourceDocuments({
          companyId,
          datasetId,
          limit: Math.max(settings.maxDocumentsPerDataset, 1),
        });
        const duplicate = existing.find((document) => document.sourceUrl === sourceUrl);
        if (duplicate) {
          throw new CorpusRequestError(
            409,
            "source_url_exists",
            "the dataset already holds a document from this address: use refresh-urls to fetch it again",
            { documentId: duplicate.id },
          );
        }
      };

      // One call per dataset and address at a time, from the first look at the dataset to the row
      // being created: a double click (or two scripts) gets one document and one 409, not two documents.
      return withKeyedLock(`${companyId}|${datasetId}|${sourceUrl}`, async () => {
        await assertNotThere();

        let fetched;
        try {
          fetched = await fetchUrl(sourceUrl, { maxBytes: settings.maxDocumentBytes });
        } catch (err) {
          throw sourceFailure(err);
        }

        // Looked at again right before the row is created: the download took time.
        await assertNotThere();
        return ingestDocument({
          companyId,
          datasetId,
          filename: name?.trim() || defaultSourceName(parsed, fetched.contentType),
          mimeType: fetched.contentType,
          bytes: fetched.bytes,
          actor,
          source: {
            url: sourceUrl,
            refreshIntervalHours: refreshIntervalHours ?? CORPUS_DEFAULT_REFRESH_INTERVAL_HOURS,
            contentHash: fetched.contentHash,
            fetchedAt: new Date().toISOString(),
          },
        });
      });
    },

    refreshDatasetUrls: async (companyId, datasetId, actor) => {
      const { settings, ports } = await requirePorts();
      await requireDataset(ports, companyId, datasetId);

      // One run per dataset at a time, and a pause between runs. Checked and taken in one
      // synchronous step, so two requests cannot both pass.
      const key = `${companyId}|${datasetId}`;
      if (refreshRunning.has(key)) {
        throw new CorpusRequestError(
          409,
          "refresh_in_progress",
          "a refresh of this dataset is already running: wait for it to finish",
        );
      }
      const finishedAt = refreshFinishedAt.get(key);
      const waitMs = finishedAt === undefined ? 0 : CORPUS_REFRESH_PAUSE_MS - (now() - finishedAt);
      if (waitMs > 0) {
        throw new CorpusRequestError(
          429,
          "refresh_too_soon",
          "this dataset was refreshed a moment ago: wait before refreshing it again",
          { retryAfterSeconds: Math.ceil(waitMs / 1000) },
        );
      }
      refreshRunning.add(key);

      let documents: CorpusDocumentRecord[];
      try {
        documents = await ports.store.listSourceDocuments({
          companyId,
          datasetId,
          limit: Math.max(settings.maxDocumentsPerDataset, 1),
        });
        await audit(actor, CORPUS_REFRESH_STARTED_ACTION, companyId, "corpus_dataset", datasetId, {
          datasetId,
          documents: documents.length,
        });
      } catch (err) {
        refreshRunning.delete(key);
        throw err;
      }

      // The downloads go on after the answer: a dataset of a thousand pages must not hold a request
      // open for hours. The counters are written to the audit log when the run ends.
      const startedAt = now();
      void (async () => {
        let details: Record<string, unknown>;
        try {
          const tally = await refreshSourceDocuments({
            ports,
            settings,
            fetcher: fetchUrl,
            documents,
            onUpdated: (document, outcome) =>
              audit(actor, CORPUS_DOCUMENT_REFRESHED_ACTION, companyId, "corpus_document", document.id, {
                datasetId,
                filename: document.filename,
                sourceUrl: document.sourceUrl,
                previousHash: outcome.previousHash,
                contentHash: outcome.contentHash,
                jobId: outcome.job.id,
                reparsed: outcome.reparsed,
              }),
          });
          details = { datasetId, ...tally, durationMs: now() - startedAt };
        } catch (err) {
          logger.error({ err, companyId, datasetId }, "corpus: a manual source refresh ended with an error");
          details = { datasetId, error: "internal_error", durationMs: now() - startedAt };
        }
        // Released before the audit row is written: whoever sees the row can start the next run.
        refreshFinishedAt.set(key, now());
        refreshRunning.delete(key);
        await audit(actor, CORPUS_REFRESH_COMPLETED_ACTION, companyId, "corpus_dataset", datasetId, details).catch(
          (err) => logger.error({ err, companyId, datasetId }, "corpus: the audit of a source refresh failed"),
        );
      })();

      return { datasetId, started: true as const, documents: documents.length };
    },

    getDocument: async (companyId, documentId) => {
      const { ports } = await requirePorts();
      const document = await ports.store.getDocument(companyId, documentId);
      if (!document) throw notFound("document");
      return toDocument(document);
    },

    reparseDocument: async (companyId, documentId, actor) => {
      const { settings, ports } = await requirePorts();
      const document = await ports.store.getDocument(companyId, documentId);
      if (!document) throw notFound("document");
      if (document.status !== "failed") {
        throw new CorpusRequestError(
          409,
          "document_not_failed",
          `only a failed document can be parsed again (this one is ${document.status})`,
          { status: document.status },
        );
      }
      if (!document.blobRef) {
        throw new CorpusRequestError(
          409,
          "document_has_no_stored_bytes",
          "the document has no stored bytes to parse again: upload it again",
        );
      }
      // Not worth a new attempt while the embedder is missing: the answer is the same 422 an
      // upload gets, and the document stays failed with its reason.
      if (ports.index.assertEmbedderConfigured) {
        await ports.index.assertEmbedderConfigured(companyId, settings.embedderBaseUrl);
      }

      // failed -> queued is the one move a failed document has; the job is armed right after it.
      const previousError = document.error;
      let queued = await ports.store.updateDocument(companyId, documentId, {
        status: "queued",
        error: null,
        attempts: 0,
      });
      if (!queued) throw notFound("document");

      let job: CorpusJobRecord;
      try {
        job = await ports.queue.enqueue({
          companyId,
          datasetId: document.datasetId,
          documentId,
          maxAttempts: settings.maxParseAttempts,
          reset: true,
        });
      } catch (err) {
        logger.error({ err, companyId, documentId }, "corpus reparse: the enqueue failed");
        await ports.store
          .updateDocument(companyId, documentId, { status: "failed", error: previousError ?? "queue_unavailable" })
          .catch(() => undefined);
        throw new CorpusRequestError(502, "enqueue_failed", "the document could not be queued for parsing");
      }

      // Read it back: the attempts the row shows come from the job, which has just started over.
      queued = (await ports.store.getDocument(companyId, documentId)) ?? queued;
      await audit(actor, CORPUS_DOCUMENT_REPARSED_ACTION, companyId, "corpus_document", documentId, {
        datasetId: document.datasetId,
        filename: document.filename,
        byteSize: document.byteSize,
        jobId: job.id,
        previousError,
      });
      return { document: toDocument(queued), job: toJob(job) };
    },

    deleteDocument: async (companyId, documentId, actor) => {
      const { ports } = await requirePorts();
      const document = await ports.store.getDocument(companyId, documentId);
      if (!document) throw notFound("document");
      await dropDerived(ports, document);
      await ports.store.deleteDocument(companyId, documentId);
      await audit(actor, CORPUS_DOCUMENT_DELETED_ACTION, companyId, "corpus_document", documentId, {
        datasetId: document.datasetId,
        filename: document.filename,
      });
    },

    getJob: async (companyId, jobId) => {
      const { ports } = await requirePorts();
      const job = await ports.store.getJob(companyId, jobId);
      if (!job) throw notFound("parse job");
      return toJob(job);
    },

    search: async (companyId, datasetId, input) => {
      const { settings, ports } = await requirePorts();
      await requireDataset(ports, companyId, datasetId);
      const query = input.query.trim();
      const limit = Math.min(Math.max(input.limit ?? settings.searchTopK, 1), 50);
      const mode = input.mode ?? "hybrid";
      if (mode !== "fulltext" && ports.index.assertEmbedderConfigured) {
        await ports.index.assertEmbedderConfigured(companyId, settings.embedderBaseUrl);
      }
      const hits = await ports.index.search({
        companyId,
        datasetId,
        query,
        limit,
        mode,
        embedderModel: settings.embedderModel,
        embedderDimensions: settings.embedderDimensions,
        embedderBaseUrl: settings.embedderBaseUrl,
      });
      // The index returns documentId per hit; resolve the real filename so the
      // REST caller can cite sources by name, not by internal UUID (OPE-12028).
      const documentIds = [...new Set(hits.map((hit) => hit.documentId))];
      const documentNames = new Map<string, string>();
      await Promise.all(
        documentIds.map(async (id) => {
          const document = await ports.store.getDocument(companyId, id);
          if (document) documentNames.set(id, document.filename);
        }),
      );
      return {
        datasetId,
        query,
        mode,
        limit,
        hits: hits.map((hit) => ({
          ...hit,
          documentName: documentNames.get(hit.documentId) ?? hit.documentId,
        })),
      };
    },

    stats: async (companyId) => {
      const { ports } = await requirePorts();
      return ports.store.counters(companyId);
    },
  };
}

/**
 * Drop what the two derived stores hold for one document. A failure here is a
 * warning, not a refusal: the board row is the source of truth, and a leftover
 * chunk or a leftover blob must not keep a document alive.
 */
async function dropDerived(ports: CorpusPorts, document: CorpusDocumentRecord): Promise<void> {
  try {
    await ports.index.deleteDocument(document.companyId, document.id);
  } catch (err) {
    logger.warn(
      { err, documentId: document.id },
      "corpus: search-index rows left behind (the document is gone from the board)",
    );
  }
  // OPE-12000: bytes of a replaced version that has not become `ready` yet.
  if (document.previousBlobRef) {
    await ports.blobs.delete(document.previousBlobRef).catch((err) => {
      logger.warn({ err, documentId: document.id }, "corpus: replaced bytes left behind (the document is gone from the board)");
    });
  }
  if (!document.blobRef) return;
  try {
    await ports.blobs.delete(document.blobRef);
  } catch (err) {
    logger.warn(
      { err, documentId: document.id },
      "corpus: stored bytes left behind (the document is gone from the board)",
    );
  }
}