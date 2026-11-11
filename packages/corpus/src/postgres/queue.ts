// myrmidon(CORPUS-A): PostgreSQL WorkQueue over corpus_parse_jobs.
// Store layer — dialect constructs (FOR UPDATE SKIP LOCKED) live only here.
import { and, eq, sql } from "drizzle-orm";
import { corpusParseJobs } from "@myrmidon/db";
import {
  PARSE_JOB_INTERRUPTED_ERROR,
  PARSE_JOB_RELEASED_ERROR,
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
    // With `reset` the job is re-armed whatever its status is (a re-parse on
    // request: attempts, error and backoff start over).
    const rearm = input.reset ? sql`true` : sql`${corpusParseJobs.status} = 'failed'`;
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
          status: sql`case when ${rearm} then 'pending' else ${corpusParseJobs.status} end`,
          attempts: sql`case when ${rearm} then 0 else ${corpusParseJobs.attempts} end`,
          lastError: sql`case when ${rearm} then null else ${corpusParseJobs.lastError} end`,
          nextAttemptAt: sql`case when ${rearm} then now() else ${corpusParseJobs.nextAttemptAt} end`,
          startedAt: sql`case when ${rearm} then null else ${corpusParseJobs.startedAt} end`,
          finishedAt: sql`case when ${rearm} then null else ${corpusParseJobs.finishedAt} end`,
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

  async claimNext(companyId: string, now?: Date): Promise<ClaimedParseJob | null> {
    // Due means due by the database clock: `next_attempt_at` is assigned by
    // PostgreSQL (`now()` on enqueue, `now() + backoff` on retry), so comparing
    // it with the application clock would either hide a just-enqueued job or,
    // with a tolerance, claim a retry before its backoff. An explicit `now` is
    // for tests only.
    const cutoff = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
    const result = await this.db.execute(sql`
      update corpus_parse_jobs
      set status = 'running',
          attempts = attempts + 1,
          started_at = now()
      where id = (
        select id from corpus_parse_jobs
        where company_id = ${companyId}
          and status = 'pending'
          and next_attempt_at <= ${cutoff}
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

  async release(
    companyId: string,
    jobId: string,
    reason: string = PARSE_JOB_RELEASED_ERROR,
  ): Promise<CorpusParseJob | null> {
    // The worker is stopping, the job is not at fault: pending again right away (the next worker
    // takes it without a backoff) and the attempt the claim counted is given back.
    const rows = await this.db
      .update(corpusParseJobs)
      .set({
        status: "pending",
        attempts: sql`greatest(${corpusParseJobs.attempts} - 1, 0)`,
        lastError: reason,
        nextAttemptAt: sql`now()`,
        startedAt: null,
      })
      .where(
        and(
          eq(corpusParseJobs.id, jobId),
          eq(corpusParseJobs.companyId, companyId),
          eq(corpusParseJobs.status, "running"),
        ),
      )
      .returning();
    return rows[0] ? toJob(rows[0]) : null;
  }

  async releaseRunning(options: { companyId?: string } = {}): Promise<CorpusParseJob[]> {
    // One statement, so a crash in the middle leaves no job half-settled. `attempts` is kept as
    // the claim counted it: a job whose parse takes the process down must run out of attempts.
    const exhausted = sql`${corpusParseJobs.attempts} >= ${corpusParseJobs.maxAttempts}`;
    const scope = options.companyId
      ? and(eq(corpusParseJobs.status, "running"), eq(corpusParseJobs.companyId, options.companyId))
      : eq(corpusParseJobs.status, "running");
    const rows = await this.db
      .update(corpusParseJobs)
      .set({
        status: sql`case when ${exhausted} then 'failed' else 'pending' end`,
        lastError: PARSE_JOB_INTERRUPTED_ERROR,
        nextAttemptAt: sql`case when ${exhausted} then ${corpusParseJobs.nextAttemptAt} else now() end`,
        startedAt: sql`case when ${exhausted} then ${corpusParseJobs.startedAt} else null end`,
        finishedAt: sql`case when ${exhausted} then now() else ${corpusParseJobs.finishedAt} end`,
      })
      .where(scope)
      .returning();
    return rows.map(toJob);
  }
}
