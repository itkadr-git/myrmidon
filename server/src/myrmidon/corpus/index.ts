// server/src/myrmidon/corpus/index.ts
//
// myrmidon(1.6.6 CORPUS-2.0 ч.C): the wiring point of the corpus module.
//
// `app.ts` mounts `myrmidonCorpusRoutes` from here; the startup in `index.ts`
// drives `createCorpusParseWorker` on the heartbeat scheduler tick (the same
// place the WIP-limit and prompt-budget sweeps live), behind
// `CORPUS_PARSE_SWEEP_INTERVAL_MS`.
//
// Everything shared with the other parts — the settings shape, the wire shapes,
// the route paths — comes from `@myrmidon/shared` (myrmidon-corpus.ts), so
// part D (MCP tools) and part E (the UI screen) read the same contract this part
// serves, and part E cannot drift from it.

export {
  myrmidonCorpusRoutes,
  type CorpusRoutesDeps,
} from "./routes.js";
export {
  CORPUS_PARSE_SWEEP_INTERVAL_MS,
  createCorpusParseWorker,
  type CorpusParseSweepResult,
  type CorpusParseWorker,
  type CorpusParseWorkerDeps,
} from "./worker.js";
export {
  CORPUS_DATASET_DELETED_ACTION,
  CORPUS_DOCUMENT_DELETED_ACTION,
  CORPUS_DOCUMENT_UPLOADED_ACTION,
  CORPUS_NOT_CONFIGURED_ERROR,
  CORPUS_SETTINGS_ACTION,
  CorpusRequestError,
  corpusService,
  type CorpusActor,
  type CorpusAuditEntry,
  type CorpusService,
  type CorpusServiceDeps,
  type CorpusSettingsView,
  type CorpusUploadInput,
  type CorpusUploadResult,
} from "./service.js";
export type {
  BlobStorePort,
  CorpusDatasetRecord,
  CorpusDocumentRecord,
  CorpusJobRecord,
  CorpusPorts,
  CorpusPortContext,
  CorpusPortsResolver,
  CorpusStorePort,
  DocumentParsePort,
  ParsedChunk,
  ParsedDocument,
  SearchHitRecord,
  SearchIndexPort,
  WorkQueuePort,
} from "./ports.js";

import type { CorpusPortsResolver } from "./ports.js";
import { createCorpusPorts, createCorpusMcpProvider } from "./adapters.js";
import type { Config } from "../../config.js";
import { corpusService } from "./service.js";

/**
 * The ports of this build.
 *
 * Parts A and B own the implementation (`packages/corpus`: the pgvector store,
 * the work queue, the blob store, the search index, the HTTP parse client) and
 * the file boundary in OPE-6165 is hard: part C never edits `packages/corpus/**`.
 * Resolve adapters only after the caller checks the module-enabled switch; this
 * keeps disabled requests and sweeps from touching corpus storage.
 */
let corpusAdapter: { db: Db; config: Config } | null = null;

export function configureCorpusAdapters(db: Db, config: Config): void {
  corpusAdapter = { db, config };
  registerCorpusMcpPortProvider(createCorpusMcpProvider(async (companyId) => {
    const view = await corpusService(db, { ports: resolveCorpusPorts }).readSettings();
    return view.settings;
  }, (context) => createCorpusPorts(db, context, config)));
}

export const resolveCorpusPorts: CorpusPortsResolver = (context) => {
  if (!context.settings.enabled || !corpusAdapter) return null;
  return createCorpusPorts(corpusAdapter.db, context, corpusAdapter.config);
};

// myrmidon(1.6.6 CORPUS-2.0, part D): what the server mounts, and the one hook
// the data side uses to reach the tools.
//
// `app.ts` mounts `myrmidonCorpusMcpRoutes(db)`; the endpoint behind it is in
// `mcp.ts`. Two things have to come from outside: the module's switch, which
// lives in `instance_settings.general.corpus` (part C writes it, part E edits
// it), and the port over the corpus itself. The switch is read here, per call,
// straight from the row, so switching the module on takes effect without a
// restart. The port arrives through `registerCorpusMcpPortProvider`, called once
// by part C when its adapter over parts A and B is ready — until then the tools
// answer `corpus_unavailable` rather than pretending the corpus is empty.
//
// Nothing here touches the corpus or the network at import time: an instance
// that never enables the module pays one row read per MCP call and nothing else.

import { instanceSettings, type Db } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import type { CorpusMcpDeps, CorpusMcpPort, CorpusMcpPortProvider } from "./contract.js";
import { myrmidonCorpusMcpRoutes as createCorpusMcpRoutes } from "./mcp.js";
import { CORPUS_SETTINGS_KEY, readCorpusModuleSettings } from "./settings.js";

/** The instance settings row the module's block lives in. */
const CORPUS_SETTINGS_ROW_KEY = "default";

let portProvider: CorpusMcpPortProvider | null = null;

/**
 * Hands the tools the company's corpus: part C calls this once, at wiring time,
 * with its adapter over `packages/corpus`. `null` (the default) means the data
 * side is not there, which the tools report as `corpus_unavailable`.
 */
export function registerCorpusMcpPortProvider(next: CorpusMcpPortProvider | null): void {
  portProvider = next;
}

/**
 * The endpoint's whole world: the stored switch, read per call, and the port the
 * data side registered. `options.port` lets a caller hand one in directly — the
 * embedded-database suite wires the fixture this way, and part C may prefer it
 * to the registry.
 */
export function myrmidonCorpusMcpDeps(
  db: Db,
  options: { port?: CorpusMcpPortProvider } = {},
): CorpusMcpDeps {
  return {
    settings: async () => {
      const row = await db
        .select({ general: instanceSettings.general })
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, CORPUS_SETTINGS_ROW_KEY))
        .then((rows) => rows[0] ?? null);
      return readCorpusModuleSettings(row?.general?.[CORPUS_SETTINGS_KEY]);
    },
    port: async (companyId: string): Promise<CorpusMcpPort | null> => {
      const resolve = options.port ?? portProvider;
      if (!resolve) return null;
      return resolve(companyId);
    },
  };
}

/** The company's corpus MCP endpoint, with the stored switch and the registered port. */
export function myrmidonCorpusMcpRoutes(db: Db, options: { port?: CorpusMcpPortProvider } = {}) {
  return createCorpusMcpRoutes(myrmidonCorpusMcpDeps(db, options));
}

export { CORPUS_MCP_ROUTE } from "./contract.js";
export type { CorpusMcpDeps, CorpusMcpPort, CorpusMcpPortProvider } from "./contract.js";
