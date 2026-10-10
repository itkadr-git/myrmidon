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
// the route paths — comes from `@paperclipai/shared` (myrmidon-corpus.ts), so
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

/**
 * The ports of this build.
 *
 * Parts A and B own the implementation (`packages/corpus`: the pgvector store,
 * the work queue, the blob store, the search index, the HTTP parse client) and
 * the file boundary in OPE-6165 is hard: part C never edits `packages/corpus/**`.
 * Until part B merges, this build has nothing to return, and `null` is the
 * documented answer for it — the routes keep serving the settings (`available:
 * false`), every data route answers 503 `corpus_not_configured` and the parse
 * sweep is a no-op. The module therefore stays silent on the fleet while any of
 * its parts is still in flight, which is exactly the acceptance criterion
 * "при выключенном модуле доска работает без изменений".
 *
 * After part B merges this becomes one line, in this file and nowhere else:
 *
 *   export const resolveCorpusPorts: CorpusPortsResolver = (context) =>
 *     createCorpusPorts({ db, env: context.env, settings: context.settings });
 *
 * The shape of what has to be returned is `CorpusPorts` in ./ports.ts.
 */
export const resolveCorpusPorts: CorpusPortsResolver = () => null;