// myrmidon(CORPUS-A): store/queue tests on embedded PostgreSQL 18, by the
// knowledge K-1 pattern (startEmbeddedPostgresTestDatabase from @paperclipai/db).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as rawSql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { PostgresCorpusStore } from "./postgres/store.js";
import { PostgresWorkQueue } from "./postgres/queue.js";
import { PostgresCorpusSettingsStore } from "./postgres/settings.js";
import { installPgvectorIntoEmbeddedCluster, type PgvectorInstall } from "./test-pgvector.js";
import {
  CORPUS_EMBEDDING_DIMENSIONS,
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
    await testDb.cleanup();
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
        where table_schema = 'public' and table_name like 'corpus_%' order by 1
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

    // Not claimable before the backoff elapses.
    expect(await queue.claimNext(companyId)).toBeNull();

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

  it("keeps per-company module settings", async () => {
    const db = createDb(testDb.connectionString);
    const settingsStore = new PostgresCorpusSettingsStore(db);
    const { companyId } = fixture;

    const defaults = await settingsStore.getSettings(companyId);
    expect(defaults.enabled).toBe(false);
    expect(defaults.defaultEmbeddingModel).toBe("dashscope-text-embedding-v4");

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
