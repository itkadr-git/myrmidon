// server/src/myrmidon/corpus/worker.ts
//
// myrmidon(1.6.6 CORPUS-2.0 ч.C): the parse worker — the background pass that
// turns an uploaded document (bytes in the BlobStore, a row in the queue) into
// parsed text in the search index, i.e. into a `ready` document.
//
// It is a board sweep, wired next to the other sweeps (see the interval list in
// `server/src/index.ts`), and it is deliberately dumb: claim the oldest queued
// jobs, run each one, settle the job. The pass is
//
//   * a NO-OP while the module is off — the settings are read first and the
//     ports are not even built, so a fleet that never enables the corpus neither
//     opens a connection nor logs anything;
//   * a no-op while the ports are not wired (parts A/B not merged yet);
//   * one job at a time inside a pass — `parseConcurrency` bounds how many jobs
//     one pass takes, not how many requests the parse service sees at once, so a
//     slow parser cannot multiply itself. The next tick picks up the rest;
//   * forgiving — any parser, indexer or blob failure settles the job through
//     `queue.fail`, which retries it until `maxParseAttempts` and then keeps the
//     reason on the document. Nothing in this pass throws into the board.

import { logger } from "../../middleware/logger.js";
import type { CorpusSettings } from "@paperclipai/shared";
import type { CorpusJobRecord, CorpusPorts, CorpusPortsResolver, ParsedChunk } from "./ports.js";

/**
 * How often a pass is worth running on the board's scheduler tick. The tick
 * itself is much faster and shared with the other sweeps, so the gate lives
 * here: an idle corpus costs one settings read every 30 s, and a document that
 * was just uploaded reaches `ready` within about half a minute.
 */
export const CORPUS_PARSE_SWEEP_INTERVAL_MS = 30_000;

/** Counters of one pass; the sweep logs them and the tests assert them. */
export interface CorpusParseSweepResult {
  /** False when the module is off — the pass did nothing and touched no port. */
  enabled: boolean;
  /** False when this process has no corpus ports (the module is on but unwired). */
  available: boolean;
  claimed: number;
  parsed: number;
  requeued: number;
  failed: number;
}

export interface CorpusParseWorkerDeps {
  /** Builds the ports of one pass, or `null` when this process cannot serve the corpus. */
  ports: CorpusPortsResolver;
  /** The settings in force (the stored block over the environment). */
  resolveSettings: () => Promise<{ settings: CorpusSettings; enabled: boolean }>;
  env?: Record<string, string | undefined>;
}

export interface CorpusParseWorker {
  /** One background pass. Never throws. */
  sweep(): Promise<CorpusParseSweepResult>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createCorpusParseWorker(deps: CorpusParseWorkerDeps): CorpusParseWorker {
  const env = deps.env ?? process.env;

  async function runJob(
    ports: CorpusPorts,
    settings: CorpusSettings,
    job: CorpusJobRecord,
  ): Promise<"parsed" | "requeued" | "failed"> {
    try {
      const document = await ports.store.getDocument(job.companyId, job.documentId);
      if (!document) {
        // The document was deleted between the enqueue and this pass: settle the
        // job instead of retrying it forever.
        await ports.queue.complete(job.companyId, job.id);
        return "parsed";
      }
      if (!document.blobRef) throw new Error("the document has no stored bytes");
      if (!settings.parserBaseUrl) {
        throw new Error("parserBaseUrl is not configured; the parse service is not addressable");
      }

      await ports.store.updateDocument(job.companyId, document.id, {
        status: "parsing",
        attempts: job.attempts,
      });

      const bytes = await ports.blobs.get(document.blobRef);
      const parsed = await ports.parser.parse({
        bytes,
        filename: document.filename,
        mimeType: document.mimeType,
        baseUrl: settings.parserBaseUrl,
        timeoutMs: settings.parserTimeoutMs,
      });

      const chunks: ParsedChunk[] =
        parsed.chunks.length > 0
          ? parsed.chunks
          : parsed.text.trim()
            ? [{ index: 0, text: parsed.text }]
            : [];
      if (chunks.length === 0) throw new Error("the parse service returned no text");

      const written = await ports.index.indexDocument({
        companyId: document.companyId,
        datasetId: document.datasetId,
        documentId: document.id,
        chunks,
        embedderModel: settings.embedderModel,
        embedderDimensions: settings.embedderDimensions,
        embedderBaseUrl: settings.embedderBaseUrl,
      });

      await ports.store.updateDocument(job.companyId, document.id, {
        status: "ready",
        chunkCount: written,
        error: null,
        parsedAt: new Date().toISOString(),
      });
      await ports.queue.complete(job.companyId, job.id);
      logger.info(
        { companyId: document.companyId, datasetId: document.datasetId, documentId: document.id, chunks: written },
        "corpus: document parsed to ready",
      );
      return "parsed";
    } catch (err) {
      const reason = message(err);
      const settled = await ports.queue
        .fail(job.companyId, job.id, reason)
        .catch(() => null);
      // The store owns the retry policy; if it did not answer, the attempts we
      // counted are the fallback. Anything else keeps the document queued.
      const exhausted = settled ? settled.state === "failed" : job.attempts + 1 >= job.maxAttempts;
      await ports.store
        .updateDocument(job.companyId, job.documentId, {
          status: exhausted ? "failed" : "queued",
          error: reason,
          attempts: job.attempts + 1,
        })
        .catch(() => null);
      logger.warn(
        {
          err,
          companyId: job.companyId,
          documentId: job.documentId,
          attempts: job.attempts + 1,
          maxAttempts: job.maxAttempts,
          exhausted,
        },
        "corpus: a parse attempt failed",
      );
      return exhausted ? "failed" : "requeued";
    }
  }

  return {
    async sweep(): Promise<CorpusParseSweepResult> {
      const result: CorpusParseSweepResult = {
        enabled: false,
        available: false,
        claimed: 0,
        parsed: 0,
        requeued: 0,
        failed: 0,
      };

      const resolved = await deps.resolveSettings();
      result.enabled = resolved.enabled;
      if (!resolved.enabled) return result; // the module is off: touch nothing

      const ports = deps.ports({ env, settings: resolved.settings });
      if (!ports) return result; // on, but this process has no ports
      result.available = true;

      const jobs = await ports.queue.claim({ limit: resolved.settings.parseConcurrency });
      result.claimed = jobs.length;

      for (const job of jobs) {
        const outcome = await runJob(ports, resolved.settings, job);
        if (outcome === "parsed") result.parsed += 1;
        else if (outcome === "requeued") result.requeued += 1;
        else result.failed += 1;
      }

      return result;
    },
  };
}