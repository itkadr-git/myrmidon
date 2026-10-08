// myrmidon(CORPUS-A): PostgreSQL WorkQueue over corpus_parse_jobs.
// Store layer — dialect constructs (FOR UPDATE SKIP LOCKED) live only here.
import { and, eq, sql } from "drizzle-orm";
import { corpusParseJobs } from "@paperclipai/db";
import {
  parseJobRetryDelayMs,
  type CorpusParseJob,
  type CorpusParseJobStatus,
} from "../domain.js";
import type { ClaimedParseJob, EnqueueParseJobInput, WorkQueue } from "../ports.js";
import type { CorpusDb } from "./types.js";

type JobRow = typeof corpusParseJobs.$inferSelect;

function toJob(row: JobRow): CorpusParseJob {
  return {
    id: row.id,
    companyId: row.companyId,
    documentId: row.documentId,
    parserVersion: row.parserVersion,
    status: row.status as CorpusParseJobStatus,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

export class PostgresWorkQueue implements WorkQueue {
  constructor(private readonly db: CorpusDb) {}

  async enqueue(input: EnqueueParseJobInput): Promise<CorpusParseJob> {
    // Idempotent on (document_id, parser_version): on conflict, return the
    // existing job unless it is terminally failed — then re-arm it to
    // `pending` so a re-enqueue rolls the failed job back into the queue.
    const rows = await this.db
      .insert(corpusParseJobs)
      .values({
        companyId: input.companyId,
        documentId: input.documentId,
        parserVersion: input.parserVersion,
        maxAttempts: input.maxAttempts ?? 3,
      })
      .onConflictDoUpdate({
        target: [corpusParseJobs.documentId, corpusParseJobs.parserVersion],
        set: {
          status: sql`case when ${corpusParseJobs.status} = 'failed' then 'pending' else ${corpusParseJobs.status} end`,
          attempts: sql`case when ${corpusParseJobs.status} = 'failed' then 0 else ${corpusParseJobs.attempts} end`,
          lastError: sql`case when ${corpusParseJobs.status} = 'failed' then null else ${corpusParseJobs.lastError} end`,
          nextAttemptAt: sql`case when ${corpusParseJobs.status} = 'failed' then now() else ${corpusParseJobs.nextAttemptAt} end`,
          startedAt: sql`case when ${corpusParseJobs.status} = 'failed' then null else ${corpusParseJobs.startedAt} end`,
          finishedAt: sql`case when ${corpusParseJobs.status} = 'failed' then null else ${corpusParseJobs.finishedAt} end`,
          maxAttempts: sql`greatest(${corpusParseJobs.maxAttempts}, excluded.max_attempts)`,
        },
      })
      .returning();
    return toJob(rows[0]!);
  }

  async getJob(companyId: string, jobId: string): Promise<CorpusParseJob | null> {
    const rows = await this.db
      .select()
      .from(corpusParseJobs)
      .where(and(eq(corpusParseJobs.id, jobId), eq(corpusParseJobs.companyId, companyId)));
    return rows[0] ? toJob(rows[0]) : null;
  }

  async listJobsForDocument(companyId: string, documentId: string): Promise<CorpusParseJob[]> {
    const rows = await this.db
      .select()
      .from(corpusParseJobs)
      .where(and(eq(corpusParseJobs.documentId, documentId), eq(corpusParseJobs.companyId, companyId)))
      .orderBy(corpusParseJobs.createdAt);
    return rows.map(toJob);
  }

  async claimNext(companyId: string, now: Date = new Date()): Promise<ClaimedParseJob | null> {
    // Atomic claim: pick the oldest due pending job and mark it running in one
    // statement; FOR UPDATE SKIP LOCKED makes concurrent workers take
    // different jobs.
    const result = await this.db.execute(sql`
      update corpus_parse_jobs
      set status = 'running',
          attempts = attempts + 1,
          started_at = now()
      where id = (
        select id from corpus_parse_jobs
        where company_id = ${companyId}
          and status = 'pending'
          and next_attempt_at <= ${now.toISOString()}
        order by next_attempt_at asc, created_at asc
        limit 1
        for update skip locked
      )
      returning *
    `);
    const row = (result as unknown as JobRow[])[0];
    return row ? toJob(row) : null;
  }

  async complete(companyId: string, jobId: string): Promise<void> {
    await this.db
      .update(corpusParseJobs)
      .set({ status: "done", finishedAt: new Date(), lastError: null })
      .where(and(eq(corpusParseJobs.id, jobId), eq(corpusParseJobs.companyId, companyId)));
  }

  async fail(companyId: string, jobId: string, error: string): Promise<CorpusParseJob> {
    const current = await this.getJob(companyId, jobId);
    if (!current) throw new Error(`corpus: parse job ${jobId} not found`);
    const exhausted = current.attempts >= current.maxAttempts;
    const rows = await this.db
      .update(corpusParseJobs)
      .set(
        exhausted
          ? { status: "failed", lastError: error, finishedAt: new Date() }
          : {
              status: "pending",
              lastError: error,
              nextAttemptAt: new Date(Date.now() + parseJobRetryDelayMs(current.attempts)),
              startedAt: null,
            },
      )
      .where(and(eq(corpusParseJobs.id, jobId), eq(corpusParseJobs.companyId, companyId)))
      .returning();
    return toJob(rows[0]!);
  }
}
