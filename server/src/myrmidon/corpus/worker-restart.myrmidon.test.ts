// myrmidon(OPE-12057): the corpus parse worker across a board restart, on embedded PostgreSQL.
//
// Two things used to go wrong when the board restarted in the middle of a parse:
//   * the job stayed `running` and its document `parsing` for good (nothing took a `running` job
//     back, and the claim only looks at `pending`);
//   * the shutdown waited for the whole pass, i.e. for the slowest parse, without a limit.
// The tests below drive the real queue and store (the production adapters over the embedded
// database); only the parse service and the embedder are replaced.

import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type Db,
  type EmbeddedPostgresTestDatabase,
} from "@myrmidon/db";
import { installPgvectorIntoEmbeddedCluster } from "@myrmidon/corpus";
import {
  CORPUS_SHUTDOWN_GRACE_ENV,
  CORPUS_SHUTDOWN_GRACE_MS,
  corpusShutdownGraceMs,
  createCorpusParseWorker,
} from "./index.js";
import { createCorpusPorts } from "./adapters.js";
import type { CorpusPortContext, CorpusPorts, DocumentParsePort } from "./ports.js";
import type { Config } from "../../config.js";

describe("corpusShutdownGraceMs", () => {
  it("defaults to 30 seconds and reads MYRMIDON_CORPUS_SHUTDOWN_GRACE_MS", () => {
    expect(CORPUS_SHUTDOWN_GRACE_MS).toBe(30_000);
    expect(corpusShutdownGraceMs({})).toBe(30_000);
    expect(corpusShutdownGraceMs({ [CORPUS_SHUTDOWN_GRACE_ENV]: "" })).toBe(30_000);
    expect(corpusShutdownGraceMs({ [CORPUS_SHUTDOWN_GRACE_ENV]: "5000" })).toBe(5_000);
    expect(corpusShutdownGraceMs({ [CORPUS_SHUTDOWN_GRACE_ENV]: "0" })).toBe(0);
    expect(corpusShutdownGraceMs({ [CORPUS_SHUTDOWN_GRACE_ENV]: "1500.9" })).toBe(1_500);
  });

  it("ignores junk and caps the wait at ten minutes", () => {
    expect(corpusShutdownGraceMs({ [CORPUS_SHUTDOWN_GRACE_ENV]: "soon" })).toBe(30_000);
    expect(corpusShutdownGraceMs({ [CORPUS_SHUTDOWN_GRACE_ENV]: "-1" })).toBe(30_000);
    expect(corpusShutdownGraceMs({ [CORPUS_SHUTDOWN_GRACE_ENV]: "999999999" })).toBe(600_000);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const pgvector = support.supported
  ? await installPgvectorIntoEmbeddedCluster()
  : { ok: false, reason: support.reason ?? "embedded PostgreSQL is unsupported", cleanup: async () => {} };
const run = support.supported && pgvector.ok ? describe : describe.skip;

if (!support.supported || !pgvector.ok) {
  console.warn(`[corpus] worker restart test skipped: ${pgvector.reason ?? support.reason}`);
}

const SETTINGS: CorpusPortContext["settings"] = {
  enabled: true,
  parserBaseUrl: "http://parser.invalid",
  parserTimeoutMs: 1000,
  embedderModel: "corpus-embed-pplx-0.6b",
  embedderDimensions: 3,
  embedderBaseUrl: "http://embedder.invalid",
  maxDocumentBytes: 1024,
  maxDocumentsPerDataset: 5,
  parseConcurrency: 1,
  maxParseAttempts: 3,
  searchTopK: 5,
};

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

run("corpus parse worker across a board restart", () => {
  let database: EmbeddedPostgresTestDatabase | undefined;
  let storageDir: string | undefined;
  let db: Db;
  let config: Config;
  let prefixSequence = 0;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("server-corpus-restart-");
    await applyPendingMigrations(database.connectionString);
    const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? os.homedir();
    storageDir = await mkdtemp(path.join(scratchRoot, "server-corpus-restart-files-"));
    db = createDb(database.connectionString);
    config = { storageLocalDiskBaseDir: storageDir } as Config;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await rm(storageDir ?? "", { recursive: true, force: true });
    await database?.cleanup();
    await pgvector.cleanup();
  });

  /** Ports over the embedded database; the parse service and the embedder are the test's own. */
  type QueueWrap = (real: CorpusPorts["queue"]) => Partial<CorpusPorts["queue"]>;
  function portsOf(context: CorpusPortContext, parser: DocumentParsePort, wrap: QueueWrap): CorpusPorts {
    const real = createCorpusPorts(db, context, config);
    return {
      ...real,
      queue: { ...real.queue, ...wrap(real.queue) },
      parser,
      index: { ...real.index, indexDocument: async (input) => input.chunks.length },
    };
  }

  const parsed = { text: "book", chunks: [{ index: 0, text: "book" }] };
  const instantParser: DocumentParsePort = { parse: async () => parsed };

  /** A worker as a board process starts one: its own state, the same database. */
  function startWorker(parser: DocumentParsePort, wrap: QueueWrap = () => ({}), settings = SETTINGS) {
    return createCorpusParseWorker({
      ports: (context) => portsOf(context, parser, wrap),
      resolveSettings: async () => ({ settings, enabled: true }),
      env: {},
    });
  }

  /** A company with one uploaded document waiting in the queue. */
  async function seed(maxAttempts = 3) {
    // The sweep claims across companies: leave no job of an earlier test behind.
    await db.execute(sql`delete from corpus_parse_jobs`);
    const companyId = randomUUID();
    prefixSequence += 1;
    await db.execute(sql`insert into companies (id, name, issue_prefix) values (${companyId}, ${`restart-${prefixSequence}`}, ${`RS${prefixSequence}`})`);
    const ports = createCorpusPorts(db, { env: {}, settings: SETTINGS }, config);
    const dataset = await ports.store.createDataset({ companyId, name: "books", description: null });
    const document = await ports.store.createDocument({
      companyId, datasetId: dataset.id, filename: "book.pdf", mimeType: "application/pdf", byteSize: 4, blobRef: "", maxAttempts,
    });
    const blob = await ports.blobs.put({ companyId, documentId: document.id, filename: "book.pdf", mimeType: "application/pdf", bytes: new TextEncoder().encode("book") });
    await ports.store.updateDocument(companyId, document.id, { blobRef: blob.ref });
    const job = await ports.queue.enqueue({ companyId, datasetId: dataset.id, documentId: document.id, maxAttempts });
    return { ports, companyId, datasetId: dataset.id, documentId: document.id, jobId: job.id };
  }

  /** What a process that dies in the middle of a parse leaves: a claimed job and a `parsing` document. */
  async function dieMidParse(seeded: Awaited<ReturnType<typeof seed>>) {
    const [claimed] = await seeded.ports.queue.claim({ limit: 1 });
    expect(claimed?.id).toBe(seeded.jobId);
    await seeded.ports.store.updateDocument(seeded.companyId, seeded.documentId, { status: "parsing", attempts: claimed!.attempts });
  }

  async function jobOf(jobId: string) {
    const rows = await db.execute(sql`select status, attempts, last_error from corpus_parse_jobs where id = ${jobId}`) as unknown as Array<{ status: string; attempts: number; last_error: string | null }>;
    return rows[0]!;
  }

  async function runningJobs(): Promise<number> {
    const rows = await db.execute(sql`select count(*)::int as n from corpus_parse_jobs where status = 'running'`) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  }

  it("frees the job a dead process left running: pending for the queue, queued for the document", async () => {
    const seeded = await seed();
    await dieMidParse(seeded);
    expect(await jobOf(seeded.jobId)).toMatchObject({ status: "running", attempts: 1 });
    expect((await seeded.ports.store.getDocument(seeded.companyId, seeded.documentId))?.status).toBe("parsing");

    // The board comes back. Its worker's first pass settles the leftovers before it claims anything;
    // here the claim is held back so the state in between can be looked at.
    let holdClaims = true;
    let released = 0;
    let claims = 0;
    const worker = startWorker(instantParser, (real) => ({
      releaseRunning: async () => {
        released += 1;
        return real.releaseRunning();
      },
      claim: async (input) => {
        claims += 1;
        return holdClaims ? [] : real.claim(input);
      },
    }));

    expect(await worker.sweep()).toMatchObject({ enabled: true, available: true, claimed: 0 });
    expect(await jobOf(seeded.jobId)).toMatchObject({ status: "pending", attempts: 1 });
    expect(await jobOf(seeded.jobId)).toMatchObject({ last_error: expect.stringContaining("restarted") });
    const document = await seeded.ports.store.getDocument(seeded.companyId, seeded.documentId);
    expect(document).toMatchObject({ status: "queued", attempts: 1 });
    expect(document?.error).toContain("restarted");
    expect(claims).toBe(1);

    // And the sweep parses it: a second attempt, the document ends up ready.
    holdClaims = false;
    expect(await worker.sweep()).toMatchObject({ claimed: 1, parsed: 1, failed: 0 });
    expect(await jobOf(seeded.jobId)).toMatchObject({ status: "done", attempts: 2 });
    expect((await seeded.ports.store.getDocument(seeded.companyId, seeded.documentId))?.status).toBe("ready");
    expect(released).toBe(1); // once per worker, not once per pass
  });

  it("does not touch a job the current process is running", async () => {
    const seeded = await seed();
    let releasedRunning = 0;
    let parseCalls = 0;
    let finishParse: () => void = () => {};
    const slowParser: DocumentParsePort = {
      parse: async () => {
        parseCalls += 1;
        await new Promise<void>((resolve) => { finishParse = resolve; });
        return parsed;
      },
    };
    const worker = startWorker(slowParser, (real) => ({
      releaseRunning: async () => {
        releasedRunning += 1;
        return real.releaseRunning();
      },
    }));

    const first = worker.sweep();
    await waitFor(() => parseCalls === 1, "the parser to receive the document");
    expect(await jobOf(seeded.jobId)).toMatchObject({ status: "running", attempts: 1 });

    // The scheduler ticks again while the book is still being parsed: nothing is released, nothing claimed.
    expect(await worker.sweep()).toMatchObject({ claimed: 0 });
    expect(await worker.sweep()).toMatchObject({ claimed: 0 });
    expect(await jobOf(seeded.jobId)).toMatchObject({ status: "running", attempts: 1 });
    expect((await seeded.ports.store.getDocument(seeded.companyId, seeded.documentId))?.status).toBe("parsing");
    expect(releasedRunning).toBe(1);
    expect(parseCalls).toBe(1);

    finishParse();
    expect(await first).toMatchObject({ claimed: 1, parsed: 1 });
    expect(await jobOf(seeded.jobId)).toMatchObject({ status: "done", attempts: 1 });
  });

  it("does not claim anything until the leftovers are settled, and tries again when that fails", async () => {
    const seeded = await seed();
    let failRelease = true;
    let claims = 0;
    const worker = startWorker(instantParser, (real) => ({
      releaseRunning: async () => {
        if (failRelease) throw new Error("the database went away");
        return real.releaseRunning();
      },
      claim: async (input) => {
        claims += 1;
        return real.claim(input);
      },
    }));

    await expect(worker.sweep()).rejects.toThrow("the database went away");
    expect(claims).toBe(0);
    expect(await jobOf(seeded.jobId)).toMatchObject({ status: "pending" });

    failRelease = false;
    expect(await worker.sweep()).toMatchObject({ claimed: 1, parsed: 1 });
  });

  it("settles a job whose document already reached ready as done, without parsing it again", async () => {
    const seeded = await seed();
    await dieMidParse(seeded);
    // The old process finished the document and died before it settled the job.
    await seeded.ports.store.updateDocument(seeded.companyId, seeded.documentId, { status: "ready", chunkCount: 1, parsedAt: new Date().toISOString() });
    let parseCalls = 0;
    const worker = startWorker({ parse: async () => { parseCalls += 1; return parsed; } });

    expect(await worker.sweep()).toMatchObject({ claimed: 0, parsed: 0 });
    expect(parseCalls).toBe(0);
    expect(await jobOf(seeded.jobId)).toMatchObject({ status: "done" });
    expect((await seeded.ports.store.getDocument(seeded.companyId, seeded.documentId))?.status).toBe("ready");
  });

  it("fails a job whose attempts are used up, so a document that kills the board does not loop", async () => {
    const seeded = await seed(1);
    await dieMidParse(seeded); // attempts 1 of 1
    let parseCalls = 0;
    const worker = startWorker({ parse: async () => { parseCalls += 1; return parsed; } });

    expect(await worker.sweep()).toMatchObject({ claimed: 0 });
    expect(parseCalls).toBe(0);
    expect(await jobOf(seeded.jobId)).toMatchObject({ status: "failed", attempts: 1, last_error: expect.stringContaining("restarted") });
    const document = await seeded.ports.store.getDocument(seeded.companyId, seeded.documentId);
    expect(document).toMatchObject({ status: "failed" });
    expect(document?.error).toContain("restarted");
  });

  describe("shutdown", () => {
    /** A parse that never ends by itself: it ends when its signal fires, like the real client. */
    function hangingParser() {
      const state = { calls: 0, signal: undefined as AbortSignal | undefined, aborted: false };
      const parser: DocumentParsePort = {
        parse: (input) =>
          new Promise((_resolve, reject) => {
            state.calls += 1;
            state.signal = input.signal;
            input.signal?.addEventListener("abort", () => {
              state.aborted = true;
              reject(new Error("the parse was aborted"));
            }, { once: true });
          }),
      };
      return { parser, state };
    }

    it("aborts a parse still running after the grace period, within the limit, and leaves nothing running", async () => {
      const seeded = await seed();
      const { parser, state } = hangingParser();
      const worker = startWorker(parser);

      const pass = worker.sweep();
      await waitFor(() => state.calls === 1, "the parser to receive the document");
      expect(await runningJobs()).toBe(1);

      const stoppedAt = Date.now();
      const stopped = await worker.stop({ graceMs: 150, abortSettleMs: 5_000 });
      const took = Date.now() - stoppedAt;

      expect(stopped).toEqual({ aborted: true, unsettled: 0 });
      expect(took).toBeGreaterThanOrEqual(140); // it did wait the grace period for the parse
      expect(took).toBeLessThan(3_000); // and did not wait for the parse itself
      expect(state.aborted).toBe(true);
      // The pass reports the job as given back, not failed or retried.
      expect(await pass).toMatchObject({ claimed: 1, released: 1, failed: 0, requeued: 0, parsed: 0 });
      // Nothing is left running; the attempt is refunded; the document is queued with no error.
      expect(await runningJobs()).toBe(0);
      expect(await jobOf(seeded.jobId)).toMatchObject({ status: "pending", attempts: 0 });
      expect(await seeded.ports.store.getDocument(seeded.companyId, seeded.documentId)).toMatchObject({ status: "queued", error: null });

      // A stopped worker claims nothing more.
      expect(await worker.sweep()).toMatchObject({ claimed: 0 });
      expect(await jobOf(seeded.jobId)).toMatchObject({ status: "pending" });

      // The board comes back and the document is parsed as if nothing happened (first attempt).
      const restarted = startWorker(instantParser);
      expect(await restarted.sweep()).toMatchObject({ claimed: 1, parsed: 1 });
      expect(await jobOf(seeded.jobId)).toMatchObject({ status: "done", attempts: 1 });
    });

    it("lets a parse that finishes within the grace period finish", async () => {
      const seeded = await seed();
      let calls = 0;
      const worker = startWorker({
        parse: async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return parsed;
        },
      });
      const pass = worker.sweep();
      await waitFor(() => calls === 1, "the parser to receive the document");

      const stopped = await worker.stop({ graceMs: 5_000 });

      expect(stopped).toEqual({ aborted: false, unsettled: 0 });
      expect(await pass).toMatchObject({ parsed: 1, released: 0 });
      expect(await jobOf(seeded.jobId)).toMatchObject({ status: "done", attempts: 1 });
      expect((await seeded.ports.store.getDocument(seeded.companyId, seeded.documentId))?.status).toBe("ready");
    });

    it("gives up waiting for a parse that ignores the abort, and the next start settles its job", async () => {
      const seeded = await seed();
      let calls = 0;
      const worker = startWorker({
        parse: () => {
          calls += 1;
          return new Promise(() => {}); // never answers, never looks at the signal
        },
      });
      void worker.sweep();
      await waitFor(() => calls === 1, "the parser to receive the document");

      const stoppedAt = Date.now();
      const stopped = await worker.stop({ graceMs: 100, abortSettleMs: 150 });

      expect(Date.now() - stoppedAt).toBeLessThan(3_000);
      expect(stopped).toEqual({ aborted: true, unsettled: 1 });
      // The job could not be given back; it is left for the next start, which settles it.
      expect(await jobOf(seeded.jobId)).toMatchObject({ status: "running" });
      const restarted = startWorker(instantParser);
      expect(await restarted.sweep()).toMatchObject({ claimed: 1, parsed: 1 });
      expect(await jobOf(seeded.jobId)).toMatchObject({ status: "done", attempts: 2 });
    });

    it("stops at once when nothing is running", async () => {
      await seed();
      const worker = startWorker(instantParser);
      const stoppedAt = Date.now();
      expect(await worker.stop()).toEqual({ aborted: false, unsettled: 0 });
      expect(Date.now() - stoppedAt).toBeLessThan(500);
    });
  });
});
