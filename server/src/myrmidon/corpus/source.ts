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
//   * same hash  -> only `lastFetchedAt` moves, nothing is parsed again;
//   * new hash   -> the new bytes replace the stored ones, the old chunks and
//                   the old bytes are dropped, and the document goes back to
//                   `queued` with a fresh parse job — the same road an upload
//                   takes after its bytes are stored;
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
import type { CorpusUrlFetcher } from "./source-fetch.js";

/** The sweep is gated to one pass per hour on the board's scheduler tick. */
export const CORPUS_SOURCE_REFRESH_INTERVAL_MS = 3_600_000;
/** Most documents one scheduled pass takes; the rest are due again an hour later. */
export const CORPUS_SOURCE_REFRESH_BATCH = 50;
/** Downloads in flight at once during a pass. */
export const CORPUS_SOURCE_REFRESH_CONCURRENCY = 4;
const MAX_REPORTED_FAILURES = 50;

export type CorpusSourceOutcome =
  | { kind: "unchanged" }
  | { kind: "updated"; job: CorpusJobRecord; previousHash: string | null; contentHash: string }
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

function describeError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const text = err instanceof Error ? err.message : String(err);
  const line = typeof code === "string" && !text.includes(code) ? `${code}: ${text}` : text;
  return line.slice(0, 300);
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

  const fail = async (error: string): Promise<CorpusSourceOutcome> => {
    logger.warn({ companyId, documentId: document.id, sourceUrl: url, error }, "corpus: a URL source could not be refreshed");
    await ports.store.updateDocument(companyId, document.id, { sourceError: error }).catch(() => null);
    return { kind: "failed", error };
  };

  let fetched;
  try {
    fetched = await fetcher(url, { maxBytes: settings.maxDocumentBytes });
  } catch (err) {
    return fail(describeError(err));
  }

  if (fetched.contentHash === document.contentHash) {
    await ports.store.updateDocument(companyId, document.id, { lastFetchedAt: fetchedAt, sourceError: null });
    return { kind: "unchanged" };
  }

  // Not worth replacing a good version while the embedder is missing: the new bytes could not
  // be indexed anyway, and the stored version keeps answering searches.
  if (ports.index.assertEmbedderConfigured) {
    try {
      await ports.index.assertEmbedderConfigured(companyId, settings.embedderBaseUrl);
    } catch (err) {
      return fail(describeError(err));
    }
  }

  const previousRef = document.blobRef;
  let blobRef: string;
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
    return fail(`blob_write_failed: ${describeError(err)}`);
  }

  const queued = await ports.store.updateDocument(companyId, document.id, {
    blobRef,
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
    await ports.blobs.delete(blobRef).catch(() => undefined);
    return { kind: "failed", error: "document_deleted" };
  }

  // The old version goes: its chunks (the new parse writes the new ones) and its bytes. A
  // failure here is a warning — the board row already points at the new bytes.
  await ports.index.deleteDocument(companyId, document.id).catch((err) => {
    logger.warn({ err, documentId: document.id }, "corpus: old chunks left behind after a source refresh");
  });
  if (previousRef && previousRef !== blobRef) {
    await ports.blobs.delete(previousRef).catch((err) => {
      logger.warn({ err, documentId: document.id }, "corpus: old bytes left behind after a source refresh");
    });
  }

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
    logger.error({ err, companyId, documentId: document.id }, "corpus: the enqueue after a source refresh failed");
    await ports.store
      .updateDocument(companyId, document.id, { status: "failed", error: "queue_unavailable" })
      .catch(() => null);
    return fail("queue_unavailable");
  }
  return { kind: "updated", job, previousHash: document.contentHash, contentHash: fetched.contentHash };
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
        outcome = { kind: "failed", error: describeError(err) };
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
