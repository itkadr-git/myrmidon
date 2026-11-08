// server/src/myrmidon/corpus/source.ts
//
// myrmidon(1.6.6 OPE-12000): keeping the documents that were added by address
// up to date. A URL-sourced document remembers where it came from (`sourceUrl`),
// how often to look again (`refreshIntervalHours`, a week unless told otherwise),
// the SHA-256 of what it holds (`contentHash`) and when it last looked
// (`lastFetchedAt`).
//
// A refresh of one document is:
//
//   * skipped while the document is still being parsed (its bytes are in use);
//   * a fetch through the guarded transport (see ./source-fetch.ts);
//   * same hash  -> only `lastFetchedAt` moves, nothing is parsed again — unless
//                   the document is `failed`: then it is parsed again from the
//                   bytes it holds;
//   * new hash   -> the new bytes replace the stored ones and the document goes
//                   back to `queued` with a fresh parse job — the same road an
//                   upload takes after its bytes are stored. The old chunks are
//                   replaced by the parse of the new version (search only sees
//                   `ready` documents), and the old bytes are removed by the
//                   parse worker once the new version is `ready`;
//   * a failed fetch (or a replace that could not finish) leaves the stored
//     version exactly as it was and records the reason in `sourceError`.
//
// The sweep below runs this for every document whose interval has passed. It is
// the product replacement of the weekly host script that used to re-download the
// platform documentation pages. Like the parse worker it is a no-op while the
// module is off or unwired.

import { logger } from "../../middleware/logger.js";
import type { CorpusSettings } from "@myrmidon/shared";
import type { CorpusDocumentRecord, CorpusJobRecord, CorpusPorts, CorpusPortsResolver } from "./ports.js";
import { CorpusSourceError, type CorpusUrlFetcher } from "./source-fetch.js";

/** The sweep is gated to one pass per hour on the board's scheduler tick. */
export const CORPUS_SOURCE_REFRESH_INTERVAL_MS = 3_600_000;
/** Most documents one scheduled pass takes; the rest are due again an hour later. */
export const CORPUS_SOURCE_REFRESH_BATCH = 50;
/** Downloads in flight at once during a pass. */
export const CORPUS_SOURCE_REFRESH_CONCURRENCY = 4;
const MAX_REPORTED_FAILURES = 50;

export type CorpusSourceOutcome =
  | { kind: "unchanged" }
  | {
      kind: "updated";
      job: CorpusJobRecord;
      previousHash: string | null;
      contentHash: string;
      /** True when the bytes were the same and the document was only parsed again (it had failed). */
      reparsed: boolean;
    }
  | { kind: "skipped"; reason: "in_flight" | "not_a_url_document" }
  | { kind: "failed"; error: string };

export interface CorpusRefreshTally {
  checked: number;
  unchanged: number;
  updated: number;
  skipped: number;
  failed: number;
  failures: Array<{ documentId: string; sourceUrl: string; error: string }>;
}

/**
 * What an API caller may read about a failure (it ends up in `sourceError`, which the corpus API returns).
 * The board's own refusals carry fixed texts and pass as they are; an embedder or parser refusal passes
 * as its code; anything else — a blob, a database, a bug — becomes the fixed code the caller names, and
 * the real error goes to the log only.
 */
function describeError(err: unknown, fallback: string, context: Record<string, unknown> = {}): string {
  if (err instanceof CorpusSourceError) return `${err.code}: ${err.message}`.slice(0, 300);
  if (err instanceof Error && err.name === "CorpusRequestError") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z_]+$/.test(code)) return code;
  }
  logger.warn({ err, ...context }, `corpus: a source refresh step failed (${fallback})`);
  return fallback;
}

/** Refreshes one URL-sourced document. Never throws: the outcome says what happened. */
export async function refreshSourceDocument(input: {
  ports: CorpusPorts;
  settings: CorpusSettings;
  fetcher: CorpusUrlFetcher;
  document: CorpusDocumentRecord;
  now?: () => Date;
}): Promise<CorpusSourceOutcome> {
  const { ports, settings, fetcher, document } = input;
  const { companyId } = document;
  const url = document.sourceUrl;
  if (!url) return { kind: "skipped", reason: "not_a_url_document" };
  if (document.status === "queued" || document.status === "parsing") {
    return { kind: "skipped", reason: "in_flight" };
  }
  const fetchedAt = (input.now?.() ?? new Date()).toISOString();
  const logContext = { companyId, documentId: document.id, sourceUrl: url };

  const fail = async (error: string): Promise<CorpusSourceOutcome> => {
    logger.warn({ ...logContext, error }, "corpus: a URL source could not be refreshed");
    await ports.store.updateDocument(companyId, document.id, { sourceError: error }).catch(() => null);
    return { kind: "failed", error };
  };

  let fetched;
  try {
    fetched = await fetcher(url, { maxBytes: settings.maxDocumentBytes });
  } catch (err) {
    return fail(describeError(err, "source_fetch_failed", logContext));
  }

  // The same bytes need no new parse — unless the last parse failed: a failed document is given
  // another go on every look at its address, the way a person would press "parse again".
  const sameContent = fetched.contentHash === document.contentHash;
  if (sameContent && document.status !== "failed") {
    await ports.store.updateDocument(companyId, document.id, { lastFetchedAt: fetchedAt, sourceError: null });
    return { kind: "unchanged" };
  }

  // Not worth replacing a good version while the embedder is missing: the new bytes could not
  // be indexed anyway, and the stored version keeps answering searches.
  if (ports.index.assertEmbedderConfigured) {
    try {
      await ports.index.assertEmbedderConfigured(companyId, settings.embedderBaseUrl);
    } catch (err) {
      return fail(describeError(err, "internal_error", logContext));
    }
  }

  // The stored bytes are reused when they are the same and still there; otherwise the new ones
  // are written first, so the row never points at bytes that do not exist.
  const previousRef = document.blobRef;
  let blobRef = previousRef;
  if (!sameContent || !previousRef) {
    try {
      const blob = await ports.blobs.put({
        companyId,
        documentId: document.id,
        filename: document.filename,
        mimeType: fetched.contentType ?? document.mimeType,
        bytes: fetched.bytes,
      });
      blobRef = blob.ref;
    } catch (err) {
      return fail(describeError(err, "blob_write_failed", logContext));
    }
  }
  const replacedBytes = blobRef !== previousRef;

  // The version before this one that was never cleaned up (its replacement failed to parse) is two
  // generations old now: nothing can need it any more.
  if (replacedBytes && document.previousBlobRef && document.previousBlobRef !== previousRef) {
    await ports.blobs.delete(document.previousBlobRef).catch((err) => {
      logger.warn({ err, ...logContext }, "corpus: older bytes left behind after a source refresh");
    });
  }

  const queued = await ports.store.updateDocument(companyId, document.id, {
    blobRef,
    // The bytes this version replaces stay until the new one is `ready` (the parse worker removes
    // them then): if the new parse never finishes, nothing has been thrown away yet.
    ...(replacedBytes ? { previousBlobRef: previousRef || null } : {}),
    byteSize: fetched.bytes.byteLength,
    mimeType: fetched.contentType ?? document.mimeType,
    contentHash: fetched.contentHash,
    lastFetchedAt: fetchedAt,
    sourceError: null,
    status: "queued",
    error: null,
    attempts: 0,
    chunkCount: 0,
    parsedAt: null,
  });
  if (!queued) {
    // Deleted while the bytes were being fetched: nothing to keep.
    if (replacedBytes) await ports.blobs.delete(blobRef).catch(() => undefined);
    return { kind: "failed", error: "document_deleted" };
  }

  // Straight after the row: a document that is `queued` must have its job. The old chunks are not
  // touched here — they are invisible to search while the document is not `ready`, and the parse of
  // the new version replaces them in one step when it indexes.
  let job: CorpusJobRecord;
  try {
    job = await ports.queue.enqueue({
      companyId,
      datasetId: document.datasetId,
      documentId: document.id,
      maxAttempts: settings.maxParseAttempts,
      reset: true,
    });
  } catch (err) {
    logger.error({ err, ...logContext }, "corpus: the enqueue after a source refresh failed");
    await ports.store
      .updateDocument(companyId, document.id, { status: "failed", error: "queue_unavailable" })
      .catch(() => null);
    return fail("queue_unavailable");
  }
  return {
    kind: "updated",
    job,
    previousHash: document.contentHash ?? null,
    contentHash: fetched.contentHash,
    reparsed: sameContent,
  };
}

/** Refreshes `documents` with a few downloads at a time; `onUpdated` hears about every replaced one. */
export async function refreshSourceDocuments(input: {
  ports: CorpusPorts;
  settings: CorpusSettings;
  fetcher: CorpusUrlFetcher;
  documents: CorpusDocumentRecord[];
  now?: () => Date;
  onUpdated?: (document: CorpusDocumentRecord, outcome: Extract<CorpusSourceOutcome, { kind: "updated" }>) => Promise<void>;
}): Promise<CorpusRefreshTally> {
  const tally: CorpusRefreshTally = { checked: 0, unchanged: 0, updated: 0, skipped: 0, failed: 0, failures: [] };
  const queue = [...input.documents];

  const worker = async (): Promise<void> => {
    for (let document = queue.shift(); document; document = queue.shift()) {
      tally.checked += 1;
      let outcome: CorpusSourceOutcome;
      try {
        outcome = await refreshSourceDocument({ ...input, document });
      } catch (err) {
        outcome = { kind: "failed", error: describeError(err, "internal_error", { documentId: document.id }) };
      }
      if (outcome.kind === "unchanged") tally.unchanged += 1;
      else if (outcome.kind === "skipped") tally.skipped += 1;
      else if (outcome.kind === "failed") {
        tally.failed += 1;
        if (tally.failures.length < MAX_REPORTED_FAILURES) {
          tally.failures.push({ documentId: document.id, sourceUrl: document.sourceUrl ?? "", error: outcome.error });
        }
      } else {
        tally.updated += 1;
        await input.onUpdated?.(document, outcome).catch((err) => {
          logger.warn({ err, documentId: document.id }, "corpus: the audit of a source refresh failed");
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CORPUS_SOURCE_REFRESH_CONCURRENCY, queue.length) }, () => worker()),
  );
  return tally;
}

export interface CorpusSourceRefreshSweepResult extends Omit<CorpusRefreshTally, "failures"> {
  /** False when the module is off — the pass did nothing and touched no port. */
  enabled: boolean;
  /** False when this process has no corpus ports. */
  available: boolean;
}

export interface CorpusSourceRefresherDeps {
  ports: CorpusPortsResolver;
  resolveSettings: () => Promise<{ settings: CorpusSettings; enabled: boolean }>;
  fetcher: CorpusUrlFetcher;
  onUpdated?: (document: CorpusDocumentRecord, outcome: Extract<CorpusSourceOutcome, { kind: "updated" }>) => Promise<void>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface CorpusSourceRefresher {
  /** One scheduled pass over the documents that are due. Never throws. */
  sweep(): Promise<CorpusSourceRefreshSweepResult>;
}

export function createCorpusSourceRefresher(deps: CorpusSourceRefresherDeps): CorpusSourceRefresher {
  const env = deps.env ?? process.env;
  // A pass can outlive the hour on a slow network; a second one must not fetch the same pages.
  let running = false;

  return {
    async sweep() {
      const result: CorpusSourceRefreshSweepResult = {
        enabled: false,
        available: false,
        checked: 0,
        unchanged: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      };
      if (running) return result;
      running = true;
      try {
        const resolved = await deps.resolveSettings();
        result.enabled = resolved.enabled;
        if (!resolved.enabled) return result; // the module is off: touch nothing

        const ports = deps.ports({ env, settings: resolved.settings });
        if (!ports) return result;
        result.available = true;

        const documents = await ports.store.listSourceDocuments({
          dueAt: deps.now?.() ?? new Date(),
          limit: CORPUS_SOURCE_REFRESH_BATCH,
        });
        if (documents.length === 0) return result;

        const tally = await refreshSourceDocuments({
          ports,
          settings: resolved.settings,
          fetcher: deps.fetcher,
          documents,
          now: deps.now,
          onUpdated: deps.onUpdated,
        });
        const { failures: _failures, ...counters } = tally;
        return { ...result, ...counters };
      } catch (err) {
        logger.error({ err }, "corpus: the source refresh pass failed");
        return result;
      } finally {
        running = false;
      }
    },
  };
}
