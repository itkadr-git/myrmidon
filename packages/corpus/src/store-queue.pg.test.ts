// myrmidon(CORPUS-A): store/queue tests on embedded PostgreSQL 18, by the
// knowledge K-1 pattern (startEmbeddedPostgresTestDatabase from @myrmidon/db).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as rawSql } from "drizzle-orm";
import { createDb } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@myrmidon/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { PostgresWorkQueue } from "./postgres/queue.js";
import { PostgresCorpusSettingsStore } from "./postgres/settings.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";
import {
  CORPUS_EMBEDDING_DIMENSIONS,
  PARSE_JOB_INTERRUPTED_ERROR,
  type CorpusDocument,
} from "./domain.js";

const support = await getEmbeddedPostgresTestSupport();
let pgvectorInstall: PgvectorInstall = { ok: false, reason: "not attempted", cleanup: async () => {} };
if (support.supported) {
  pgvectorInstall = await installPgvectorIntoEmbeddedCluster();
}
const runnable = support.supported && pgvectorInstall.ok;
const d = runnable ? describe : describe.skip;

if (!runnable) {
  console.warn(
    `corpus store tests skipped: ${
      support.supported ? pgvectorInstall.reason : (support.reason ?? "embedded Postgres unsupported")
    }`,
  );
}

afterAll(async () => {
  await pgvectorInstall.cleanup();
});

function rowsOf<T>(result: unknown): T[] {
  // drizzle's db.execute over the postgres.js driver returns the driver Result,
  // which is an Array of row objects.
  return result as unknown as T[];
}

type Fixture = {
  store: PostgresCorpusStore;
  queue: PostgresWorkQueue;
  companyId: string;
  datasetId: string;
};

d("corpus store/queue on embedded Postgres", () => {
  let testDb: EmbeddedPostgresTestDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("corpus-pg-test-");
    const db = createDb(testDb.connectionString);
    const store = new PostgresCorpusStore(db);
    const queue = new PostgresWorkQueue(db);
    const companyId = crypto.randomUUID();
    await db.execute(rawSql`
      insert into companies (id, name, issue_prefix) values (${companyId}, 'corpus-test', 'CT')
    `);
    const dataset = await store.createDataset({ companyId, name: "main" });
    fixture = { store, queue, companyId, datasetId: dataset.id };
  }, 120_000);

  afterAll(async () => {
    try {
      await testDb.cleanup();
    } finally {
      await pgvectorInstall.cleanup();
    }
  });

  function embedding(seed: number): number[] {
    return Array.from({ length: CORPUS_EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(seed + i));
  }

  it("migrates a clean database and is re-runnable (additive idempotency)", async () => {
    // The harness applied every migration: 0309 created the corpus tables
    // without touching pgvector (OPE-6233), and 0310 added the pgvector
    // extension, the embedding column and the HNSW index (this test DB has
    // pgvector installed via test-pgvector). All corpus DDL carries
    // IF NOT EXISTS, so re-applying it must not error — additive idempotency.
    const db = createDb(testDb.connectionString);
    const ddl = rowsOf<{ n: number }>(
      await db.execute(rawSql`
        select count(*)::int as n
        from pg_catalog.pg_extension where extname in ('vector', 'pg_trgm')
      `),
    );
    expect(ddl[0]!.n).toBe(2);

    const vectorColumns = rowsOf<{ n: number }>(
      await db.execute(rawSql`
        select count(*)::int as n
        from information_schema.columns
        where table_schema = 'public' and table_name = 'corpus_chunks' and column_name = 'embedding'
      `),
    );
    expect(vectorColumns[0]!.n).toBe(1);

    const vectorIndexes = rowsOf<{ n: number }>(
      await db.execute(rawSql`
        select count(*)::int as n
        from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'corpus_chunks'
          and indexname = 'corpus_chunks_embedding_hnsw_idx'
      `),
    );
    expect(vectorIndexes[0]!.n).toBe(1);

    const tables = rowsOf<{ table_name: string }>(
      await db.execute(rawSql`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name like 'corpus_%'
          and table_name <> 'corpus_shadow_log' order by 1
      `),
    );
    const names = tables.map((r) => r.table_name);
    expect(names).toEqual([
      "corpus_chunks",
      "corpus_datasets",
      "corpus_documents",
      "corpus_parse_jobs",
      "corpus_settings",
    ]);
  });

  it("drives a document through queued -> parsing -> embedding -> ready", async () => {
    const { store, queue, companyId, datasetId } = fixture;
    const doc = await store.createDocument({ companyId, datasetId, title: "spec.pdf" });
    expect(doc.status).toBe("queued");

    const job = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1" });
    expect(job.status).toBe("pending");

    const claimed = await queue.claimNext(companyId);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.status).toBe("running");
    expect(claimed!.attempts).toBe(1);

    const parsing = await store.updateDocumentStatus(companyId, doc.id, "parsing", {
      parserVersion: "v1",
    });
    expect(parsing.status).toBe("parsing");

    const embeddingState = await store.updateDocumentStatus(companyId, doc.id, "embedding");
    expect(embeddingState.status).toBe("embedding");

    const chunks = await store.replaceDocumentChunks({
      companyId,
      documentId: doc.id,
      chunks: [
        { chunkIndex: 0, content: "The corpus stores knowledge.", embedding: embedding(1) },
        { chunkIndex: 1, content: "Retrieval is hybrid vector plus FTS.", embedding: embedding(2) },
      ],
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.embedding).toHaveLength(CORPUS_EMBEDDING_DIMENSIONS);

    const ready = await store.updateDocumentStatus(companyId, doc.id, "ready");
    expect(ready.status).toBe("ready");
    expect(ready.parsedAt).not.toBeNull();

    await queue.complete(companyId, job.id);
    const done = await queue.getJob(companyId, job.id);
    expect(done!.status).toBe("done");

    // A full read-back: FTS column is maintained by Postgres.
    const listed = await store.listDocumentChunks(companyId, doc.id);
    expect(listed.map((c) => c.chunkIndex)).toEqual([0, 1]);
  });

  it("enqueue is idempotent on (document_id, parser_version)", async () => {
    const { store, queue, companyId, datasetId } = fixture;
    const doc = await store.createDocument({ companyId, datasetId, title: "idem.txt" });

    const first = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1" });
    const second = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1" });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("pending");

    const jobs = await queue.listJobsForDocument(companyId, doc.id);
    expect(jobs).toHaveLength(1);

    // A different parser version is a different job.
    const other = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v2" });
    expect(other.id).not.toBe(first.id);
    expect(await queue.listJobsForDocument(companyId, doc.id)).toHaveLength(2);
  });

  it("rolls a failed job back into the queue on re-enqueue", async () => {
    const { store, queue } = fixture;
    // Fresh company so claimNext does not race jobs from other tests.
    const companyId = crypto.randomUUID();
    const db = createDb(testDb.connectionString);
    await db.execute(rawSql`
      insert into companies (id, name, issue_prefix) values (${companyId}, 'retry-co', 'RC')
    `);
    const dataset = await store.createDataset({ companyId, name: "retry" });
    const datasetId = dataset.id;
    const doc = await store.createDocument({ companyId, datasetId, title: "flaky.pdf" });
    const job = await queue.enqueue({
      companyId,
      documentId: doc.id,
      parserVersion: "v1",
      maxAttempts: 2,
    });

    // First attempt fails -> back to pending with backoff.
    const claimed1 = await queue.claimNext(companyId);
    expect(claimed1!.id).toBe(job.id);
    const retry = await queue.fail(companyId, job.id, "parser timed out");
    expect(retry.status).toBe("pending");
    expect(retry.attempts).toBe(1);
    expect(retry.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    expect(await queue.claimNext(companyId)).toBeNull();

    // The SQL cutoff must not claim work whose retry timestamp is still ahead.
    await db.execute(rawSql`
      update corpus_parse_jobs set next_attempt_at = now() + interval '5 seconds'
      where id = ${job.id}
    `);
    expect(await queue.claimNext(companyId, new Date(Date.now() + 1000))).toBeNull();

    // Force the backoff due and fail the second attempt -> exhausted, failed.
    await db.execute(rawSql`
      update corpus_parse_jobs set next_attempt_at = now() - interval '1 second'
      where id = ${job.id}
    `);
    const claimed2 = await queue.claimNext(companyId);
    expect(claimed2!.id).toBe(job.id);
    const failed = await queue.fail(companyId, job.id, "parser crashed");
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(2);

    await store.updateDocumentStatus(companyId, doc.id, "parsing", { parserVersion: "v1" });
    const failedDoc = await store.updateDocumentStatus(companyId, doc.id, "failed", {
      parseError: "parser crashed",
    });
    expect(failedDoc.status).toBe("failed");

    // The rollback path: re-enqueueing the same (document, parser_version)
    // re-arms the failed job instead of creating a duplicate.
    const rearmed = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1" });
    expect(rearmed.id).toBe(job.id);
    expect(rearmed.status).toBe("pending");
    expect(rearmed.attempts).toBe(0);
    expect(rearmed.lastError).toBeNull();
    expect(await queue.listJobsForDocument(companyId, doc.id)).toHaveLength(1);

    // And the document itself can be re-queued.
    const requeued = await store.updateDocumentStatus(companyId, doc.id, "queued");
    expect(requeued.status).toBe("queued");
  });

  it("re-enqueue with reset re-arms the job of a re-parse whatever its status is", async () => {
    const { store, queue } = fixture;
    const companyId = crypto.randomUUID();
    const db = createDb(testDb.connectionString);
    await db.execute(rawSql`
      insert into companies (id, name, issue_prefix) values (${companyId}, 'reparse-co', 'RP')
    `);
    const dataset = await store.createDataset({ companyId, name: "reparse" });
    const doc = await store.createDocument({ companyId, datasetId: dataset.id, title: "book.pdf" });
    const job = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1", maxAttempts: 3 });

    // A pending job that failed once sits in its backoff with one attempt used.
    await queue.claimNext(companyId);
    const backoff = await queue.fail(companyId, job.id, "parser timed out");
    expect(backoff).toMatchObject({ status: "pending", attempts: 1 });
    expect(backoff.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // Without the flag a re-enqueue leaves such a job alone ...
    const untouched = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1" });
    expect(untouched).toMatchObject({ id: job.id, status: "pending", attempts: 1 });
    // ... with it the attempts and the backoff start over.
    const reset = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1", reset: true });
    expect(reset).toMatchObject({ id: job.id, status: "pending", attempts: 0, lastError: null });
    expect(reset.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // A job left `running` (the process that held it died) and a `done` one come back too.
    for (const stale of ["running", "done"] as const) {
      await db.execute(rawSql`
        update corpus_parse_jobs set status = ${stale}, attempts = 2, last_error = 'old', finished_at = now()
        where id = ${job.id}
      `);
      const rearmed = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1", reset: true });
      expect(rearmed).toMatchObject({ id: job.id, status: "pending", attempts: 0, lastError: null, finishedAt: null });
      expect(await queue.listJobsForDocument(companyId, doc.id)).toHaveLength(1);
    }
    const claimed = await queue.claimNext(companyId);
    expect(claimed?.id).toBe(job.id);
  });

  it("enforces company scoping and legal transitions", async () => {
    const { store, queue, companyId, datasetId } = fixture;
    const otherCompany = crypto.randomUUID();
    const db = createDb(testDb.connectionString);
    await db.execute(rawSql`
      insert into companies (id, name, issue_prefix) values (${otherCompany}, 'other', 'OT')
    `);

    const doc: CorpusDocument = await store.createDocument({
      companyId,
      datasetId,
      title: "scoped.md",
    });
    expect(await store.getDocument(otherCompany, doc.id)).toBeNull();
    expect(await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1" })).toBeTruthy();

    await expect(store.updateDocumentStatus(companyId, doc.id, "ready")).rejects.toThrow(/illegal/);
  });

  describe("jobs left running by a worker that is gone (OPE-12057)", () => {
    async function freshCompany(prefix: string) {
      const { store } = fixture;
      const companyId = crypto.randomUUID();
      const db = createDb(testDb.connectionString);
      await db.execute(rawSql`
        insert into companies (id, name, issue_prefix) values (${companyId}, ${`restart-${prefix}`}, ${prefix})
      `);
      const dataset = await store.createDataset({ companyId, name: `restart-${prefix}` });
      return { companyId, datasetId: dataset.id, db };
    }

    it("releaseRunning puts running jobs back to pending and fails the ones with no attempts left", async () => {
      const { store, queue } = fixture;
      const { companyId, datasetId, db } = await freshCompany("RR1");
      const other = await freshCompany("RR2");
      const enqueue = async (owner: { companyId: string; datasetId: string }, title: string, maxAttempts: number) => {
        const doc = await store.createDocument({ companyId: owner.companyId, datasetId: owner.datasetId, title });
        return queue.enqueue({ companyId: owner.companyId, documentId: doc.id, parserVersion: "v1", maxAttempts });
      };
      const retried = await enqueue({ companyId, datasetId }, "retried.pdf", 3);
      const lastChance = await enqueue({ companyId, datasetId }, "last-chance.pdf", 1);
      const otherJob = await enqueue(other, "other.pdf", 3);
      // Two jobs of this company and one of another company are claimed; then the worker dies.
      expect((await queue.claimNext(companyId))?.id).toBe(retried.id);
      expect((await queue.claimNext(companyId))?.id).toBe(lastChance.id);
      expect((await queue.claimNext(other.companyId))?.id).toBe(otherJob.id);
      // A job that was never claimed and a finished one are not "left running".
      const waiting = await enqueue({ companyId, datasetId }, "waiting.pdf", 3);
      const finished = await enqueue({ companyId, datasetId }, "finished.pdf", 3);
      await db.execute(rawSql`update corpus_parse_jobs set status = 'done', finished_at = now() where id = ${finished.id}`);

      const released = await queue.releaseRunning({ companyId });

      expect(released.map((job) => job.id).sort()).toEqual([retried.id, lastChance.id].sort());
      const back = released.find((job) => job.id === retried.id)!;
      expect(back).toMatchObject({ status: "pending", attempts: 1, lastError: PARSE_JOB_INTERRUPTED_ERROR, startedAt: null, finishedAt: null });
      expect(back.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000); // due at once, no backoff
      const spent = released.find((job) => job.id === lastChance.id)!;
      expect(spent).toMatchObject({ status: "failed", attempts: 1, lastError: PARSE_JOB_INTERRUPTED_ERROR });
      expect(spent.finishedAt).not.toBeNull();
      // The others are as they were: another company's running job, the waiting job, the done one.
      expect((await queue.getJob(other.companyId, otherJob.id))?.status).toBe("running");
      expect((await queue.getJob(companyId, waiting.id))?.status).toBe("pending");
      expect((await queue.getJob(companyId, finished.id))?.status).toBe("done");

      // The released job is claimable again straight away, and that is a new attempt.
      const claimedAgain: string[] = [];
      for (let claimed = await queue.claimNext(companyId); claimed; claimed = await queue.claimNext(companyId)) {
        claimedAgain.push(claimed.id);
        if (claimed.id === retried.id) expect(claimed.attempts).toBe(2);
      }
      expect(claimedAgain.sort()).toEqual([retried.id, waiting.id].sort());

      // Without a company the whole queue is settled.
      const all = await queue.releaseRunning();
      expect(all.map((job) => job.id)).toEqual(expect.arrayContaining([retried.id, waiting.id, otherJob.id]));
      expect((await queue.getJob(other.companyId, otherJob.id))?.status).toBe("pending");
      expect(await queue.releaseRunning({ companyId })).toHaveLength(0);
      expect(await queue.releaseRunning({ companyId: other.companyId })).toHaveLength(0);
    });

    it("release gives a running job back with its attempt refunded, and only a running one", async () => {
      const { store, queue } = fixture;
      const { companyId, datasetId } = await freshCompany("RR3");
      const doc = await store.createDocument({ companyId, datasetId, title: "stopping.pdf" });
      const job = await queue.enqueue({ companyId, documentId: doc.id, parserVersion: "v1", maxAttempts: 3 });

      expect(await queue.release(companyId, job.id, "stopping")).toBeNull(); // pending: nothing to give back
      const claimed = await queue.claimNext(companyId);
      expect(claimed).toMatchObject({ id: job.id, status: "running", attempts: 1 });

      expect(await queue.release(crypto.randomUUID(), job.id, "stopping")).toBeNull(); // another company's call
      const given = await queue.release(companyId, job.id, "stopping");
      expect(given).toMatchObject({ id: job.id, status: "pending", attempts: 0, lastError: "stopping", startedAt: null });
      expect(given!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(await queue.release(companyId, job.id, "stopping")).toBeNull(); // twice is harmless

      // The next worker takes it at once, as its first attempt, not its second.
      expect(await queue.claimNext(companyId)).toMatchObject({ id: job.id, attempts: 1 });
    });
  });

  it("keeps per-company module settings", async () => {
    const db = createDb(testDb.connectionString);
    const settingsStore = new PostgresCorpusSettingsStore(db);
    const { companyId } = fixture;

    const defaults = await settingsStore.getSettings(companyId);
    expect(defaults.enabled).toBe(false);
    expect(defaults.defaultEmbeddingModel).toBe("corpus-embed-pplx-0.6b");

    const updated = await settingsStore.updateSettings(companyId, {
      enabled: true,
      defaultParserUrl: "http://parser.internal:8080",
    });
    expect(updated.enabled).toBe(true);
    expect(updated.defaultParserUrl).toBe("http://parser.internal:8080");

    const reread = await settingsStore.getSettings(companyId);
    expect(reread).toEqual(updated);
  });
});
