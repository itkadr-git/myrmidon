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
//   * bounded parallel jobs — `parseConcurrency` caps simultaneous parser and
//     indexing work ACROSS passes: a pass can outlive many scheduler ticks (a big
//     scanned book takes the better part of an hour), so a pass claims only as
//     many jobs as are free right now; the next tick picks up the rest;
//   * forgiving — any parser, indexer or blob failure settles the job through
//     `queue.fail`, which retries it until `maxParseAttempts` and then keeps the
//     reason on the document. Nothing in this pass throws into the board;
//   * restart-proof (OPE-12057) — the worker is the only one in its process, so the
//     jobs it finds `running` on its first pass belong to a process that is gone (a
//     restart or a kill in the middle of a parse): it settles them before it claims
//     anything, otherwise they stay `running`, and their documents `parsing`, forever;
//   * stoppable — `stop()` lets the parses in flight finish for a grace period, then
//     aborts them (the parser client cancels the job in the parse service) and gives
//     their jobs back, so a board restart waits a bounded time, not a whole book.

import { logger } from "../../middleware/logger.js";
import type { CorpusSettings } from "@myrmidon/shared";
import type { CorpusJobRecord, CorpusPorts, CorpusPortsResolver, ParsedChunk } from "./ports.js";
import { CorpusRequestError, CORPUS_EMBEDDER_NOT_CONFIGURED_ERROR } from "./service.js";

/**
 * How often a pass is worth running on the board's scheduler tick. The tick
 * itself is much faster and shared with the other sweeps, so the gate lives
 * here: an idle corpus costs one settings read every 30 s, and a document that
 * was just uploaded reaches `ready` within about half a minute.
 */
export const CORPUS_PARSE_SWEEP_INTERVAL_MS = 150_000;

/** Environment variable that sets how long a board shutdown waits for the parses in flight. */
export const CORPUS_SHUTDOWN_GRACE_ENV = "MYRMIDON_CORPUS_SHUTDOWN_GRACE_MS";
/** How long a shutdown lets the running parses finish before it aborts them. */
export const CORPUS_SHUTDOWN_GRACE_MS = 30_000;
/** After the abort: how long the shutdown waits for the aborted parses to give their jobs back. */
export const CORPUS_SHUTDOWN_ABORT_SETTLE_MS = 10_000;
const CORPUS_SHUTDOWN_GRACE_MAX_MS = 600_000;

/**
 * The shutdown grace period from the environment: whole milliseconds, 0 (abort at once) to ten
 * minutes; anything else, or nothing, is the default of 30 s.
 */
export function corpusShutdownGraceMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[CORPUS_SHUTDOWN_GRACE_ENV]?.trim();
  if (!raw) return CORPUS_SHUTDOWN_GRACE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return CORPUS_SHUTDOWN_GRACE_MS;
  return Math.min(Math.floor(value), CORPUS_SHUTDOWN_GRACE_MAX_MS);
}

/** `last_error` the store keeps on a job its worker gave back at shutdown. */
const JOB_RELEASED_AT_SHUTDOWN = "the board is shutting down; the parse starts over after the restart";

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
  /** Jobs given back unfinished because the board is shutting down (attempt refunded). */
  released: number;
}

export interface CorpusParseStopOptions {
  /** How long the parses in flight may keep running before they are aborted. Default 30 s. */
  graceMs?: number;
  /** After the abort: how long to wait for the aborted parses to settle. Default 10 s. */
  abortSettleMs?: number;
}

export interface CorpusParseStopResult {
  /** The grace period ran out with parses still running, so they were told to abort. */
  aborted: boolean;
  /** Passes still not settled when `stop` gave up; their `running` jobs wait for the next start. */
  unsettled: number;
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
  /**
   * Stops the worker for the board's shutdown: no new pass claims anything, the parses in flight
   * get `graceMs` to finish, then they are aborted (the parser job is cancelled, the corpus job
   * goes back to the queue with its attempt refunded, the document to `queued`) and `abortSettleMs`
   * more is allowed for that. Bounded by the sum of the two; never throws.
   */
  stop(options?: CorpusParseStopOptions): Promise<CorpusParseStopResult>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves true when `work` settles within `ms`, false when the time runs out first. */
function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void work.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Thrown inside a job once the worker is stopping: the job is given back, not failed. */
class CorpusParseStoppedError extends Error {
  constructor() {
    super("the corpus parse worker is stopping");
    this.name = "CorpusParseStoppedError";
  }
}

export function createCorpusParseWorker(deps: CorpusParseWorkerDeps): CorpusParseWorker {
  const env = deps.env ?? process.env;

  // Jobs this worker holds right now: claimed and not yet settled, whichever pass took them.
  // The scheduler starts a pass every CORPUS_PARSE_SWEEP_INTERVAL_MS no matter whether the
  // previous one has finished, and a pass lasts as long as its slowest parse. Counting per pass
  // would let every new pass claim another `parseConcurrency` jobs on top of the ones still
  // running, and the parser would be handed more documents than it can work on at once.
  let inFlight = 0;

  // Shutdown. `stopping` keeps new passes from claiming; the controller's signal reaches the parser
  // and the embedder, and every step of a job looks at it, once the grace period has run out.
  let stopping = false;
  const stopController = new AbortController();
  // The passes in progress, so `stop()` can wait for them.
  const passes = new Set<Promise<unknown>>();

  // The jobs a previous process left `running`: settled once, by the first pass that has ports,
  // before the worker claims anything. Shared by passes that overlap; retried after a failure.
  let recovery: Promise<void> | null = null;

  async function recoverInterruptedJobs(ports: CorpusPorts): Promise<void> {
    // This worker has claimed nothing yet (it is the only claimer of its process and recovery comes
    // before the first claim), so every `running` job in the queue was left by a process that is gone.
    const released = await ports.queue.releaseRunning();
    if (released.length === 0) return;
    let requeued = 0;
    let failed = 0;
    let completed = 0;
    for (const job of released) {
      try {
        const document = await ports.store.getDocument(job.companyId, job.documentId);
        if (!document) continue; // deleted meanwhile: the job went with it
        if (document.status === "ready") {
          // The previous process got as far as `ready` and died before it settled the job.
          await ports.queue.complete(job.companyId, job.id);
          completed += 1;
        } else if (job.state === "failed") {
          await ports.store.updateDocument(job.companyId, job.documentId, {
            status: "failed",
            error: job.lastError,
            attempts: job.attempts,
          });
          failed += 1;
        } else {
          await ports.store.updateDocument(job.companyId, job.documentId, {
            status: "queued",
            error: job.lastError,
            attempts: job.attempts,
          });
          requeued += 1;
        }
      } catch (err) {
        // The job itself is settled; a document left `parsing` heals when the job is claimed again.
        logger.warn({ err, companyId: job.companyId, jobId: job.id }, "corpus: could not settle the document of a released job");
      }
    }
    logger.warn(
      { released: released.length, requeued, failed, completed },
      "corpus: parse jobs left running by a previous process were released",
    );
  }

  function recoverOnce(ports: CorpusPorts): Promise<void> {
    recovery ??= recoverInterruptedJobs(ports).catch((err) => {
      recovery = null; // the next pass tries again; until it works nothing is claimed
      throw err;
    });
    return recovery;
  }

  /** The board is stopping and this job is not done: give it back, the document to `queued`. */
  async function giveBack(ports: CorpusPorts, job: CorpusJobRecord): Promise<"released"> {
    try {
      const released = await ports.queue.release(job.companyId, job.id, JOB_RELEASED_AT_SHUTDOWN);
      if (released) {
        await ports.store.updateDocument(job.companyId, job.documentId, {
          status: "queued",
          error: null,
          attempts: released.attempts,
        });
      }
    } catch (err) {
      // The job stays `running`: the next start settles it like any job a crash left behind.
      logger.warn({ err, companyId: job.companyId, jobId: job.id }, "corpus: could not give a job back at shutdown");
    }
    return "released";
  }

  async function runJob(
    ports: CorpusPorts,
    settings: CorpusSettings,
    job: CorpusJobRecord,
  ): Promise<"parsed" | "requeued" | "failed" | "released"> {
    const signal = stopController.signal;
    const checkpoint = () => {
      if (signal.aborted) throw new CorpusParseStoppedError();
    };
    try {
      checkpoint();
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
      checkpoint();
      const parsed = await ports.parser.parse({
        bytes,
        filename: document.filename,
        mimeType: document.mimeType,
        baseUrl: settings.parserBaseUrl,
        timeoutMs: settings.parserTimeoutMs,
        signal,
      });
      checkpoint();

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
        signal,
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
      // Stopped by the board's shutdown (the abort made the parser or the embedder throw, or a
      // checkpoint did): not the document's fault, so no attempt is spent and no error is recorded.
      if (signal.aborted) return giveBack(ports, job);
      const reason = message(err);
      const isEmbedderConfigError =
        (err instanceof CorpusRequestError && err.code === CORPUS_EMBEDDER_NOT_CONFIGURED_ERROR) ||
        reason.includes(CORPUS_EMBEDDER_NOT_CONFIGURED_ERROR);
      const settled = await ports.queue
        .fail(job.companyId, job.id, reason)
        .catch(() => null);
      // The store owns the retry policy; if it did not answer, the attempts we
      // counted are the fallback. Anything else keeps the document queued.
      // Configuration errors are unretryable: fail the document immediately.
      const exhausted = isEmbedderConfigError || (settled ? settled.state === "failed" : job.attempts + 1 >= job.maxAttempts);
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

  async function pass(): Promise<CorpusParseSweepResult> {
    const result: CorpusParseSweepResult = {
      enabled: false,
      available: false,
      claimed: 0,
      parsed: 0,
      requeued: 0,
      failed: 0,
      released: 0,
    };
    if (stopping) return result; // the board is shutting down: no new claims

    const resolved = await deps.resolveSettings();
    result.enabled = resolved.enabled;
    if (!resolved.enabled) return result; // the module is off: touch nothing

    const ports = deps.ports({ env, settings: resolved.settings });
    if (!ports) return result; // on, but this process has no ports
    result.available = true;

    // First pass of this worker (inFlight is 0, nothing was claimed yet): settle what a previous
    // process left `running`. Everything below waits for it, or the worker could take its own
    // fresh jobs for leftovers.
    await recoverOnce(ports);
    if (stopping) return result;

    const free = resolved.settings.parseConcurrency - inFlight;
    if (free <= 0) return result; // every slot is busy with a job of an earlier pass

    // The slots are reserved before the claim is awaited: two passes asking at the same
    // moment must not both see them free.
    inFlight += free;
    let jobs: CorpusJobRecord[];
    try {
      jobs = await ports.queue.claim({ limit: free });
    } catch (err) {
      inFlight -= free;
      throw err;
    }
    inFlight -= free - jobs.length;
    result.claimed = jobs.length;

    await Promise.all(jobs.map(async (job) => {
      try {
        const outcome = await runJob(ports, resolved.settings, job);
        if (outcome === "parsed") result.parsed += 1;
        else if (outcome === "requeued") result.requeued += 1;
        else if (outcome === "released") result.released += 1;
        else result.failed += 1;
      } catch (err) {
        // A failed persistence operation must not abandon the other claimed jobs.
        result.failed += 1;
        logger.error({ err, companyId: job.companyId, jobId: job.id }, "corpus: could not settle a claimed job");
      } finally {
        inFlight -= 1;
      }
    }));

    return result;
  }

  return {
    sweep(): Promise<CorpusParseSweepResult> {
      const running = pass();
      // `stop()` waits for the pass; a failure of it reaches the caller of `sweep`, not `stop`.
      const tracked = running.then(
        () => undefined,
        () => undefined,
      ).finally(() => passes.delete(tracked));
      passes.add(tracked);
      return running;
    },

    async stop(options: CorpusParseStopOptions = {}): Promise<CorpusParseStopResult> {
      const graceMs = options.graceMs ?? CORPUS_SHUTDOWN_GRACE_MS;
      const abortSettleMs = options.abortSettleMs ?? CORPUS_SHUTDOWN_ABORT_SETTLE_MS;
      stopping = true;
      if (await settlesWithin(Promise.all([...passes]), graceMs)) return { aborted: false, unsettled: 0 };

      logger.warn(
        { inFlight, graceMs },
        "corpus: parses are still running at shutdown; aborting them, their jobs go back to the queue",
      );
      stopController.abort();
      if (await settlesWithin(Promise.all([...passes]), abortSettleMs)) return { aborted: true, unsettled: 0 };

      const unsettled = passes.size;
      logger.error(
        { unsettled, abortSettleMs },
        "corpus: aborted parses did not settle in time; their running jobs are released at the next start",
      );
      return { aborted: true, unsettled };
    },
  };
}