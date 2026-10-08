// server/src/myrmidon/bot-containers/apply-jobs.ts
//
// myrmidon(1.6.5 ASYNC-BOT-APPLY): the journal of "Apply now" requests.
//
// The apply pass used to run inside the HTTP request and held it for the whole
// reconcile (~36 s on a cold restart), so the button looked frozen and proxies
// could cut the connection before the outcome was known. The pass now runs in
// the background of the same process and every request lands as one row in
// bot_apply_jobs: pending -> running -> succeeded | failed, with the failure
// text stored so it is visible from the status route, never lost in a catch.
//
// Idempotency is the store's job: while a bot has a LIVE (pending/running) row,
// acquireLiveJob returns that row instead of inserting a second one, so double
// clicking the button queues one pass, not two. The database enforces the same
// rule with a partial unique index (one live row per bot), which is what makes
// two racing POSTs safe: the loser hits the unique violation and re-reads the
// winner's row.

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { botApplyJobs, type BotApplyJobStatus, type Db } from "@paperclipai/db";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

/**
 * A live (pending/running) job older than this is an orphan: the background
 * pass lives in the process that took the POST, so if that process died
 * mid-pass the row would stay live for ever and — through the one-live-job-
 * per-bot unique index — would answer every later POST with the dead job's id.
 * A real pass takes tens of seconds (~36 s cold restart), so ten minutes is
 * far beyond any live run.
 */
export const BOT_APPLY_JOB_STALE_MS = 10 * 60 * 1000;
const STALE_JOB_ERROR = "apply job abandoned: the board process that ran it stopped before the pass finished";

export interface BotApplyJob {
  id: string;
  companyId: string;
  botId: string;
  status: BotApplyJobStatus;
  error: string | null;
  requestedBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** False when acquireLiveJob handed back a job that already existed — the
   *  caller must not start a second background pass for a reused live job. */
  created: boolean;
}

export interface BotApplyJobStore {
  /** The live (pending/running) job of this bot, or a new pending job. */
  acquireLiveJob(input: { companyId: string; botId: string; requestedBy: string | null }): Promise<BotApplyJob>;
  /** pending -> running, stamping startedAt. */
  markRunning(jobId: string): Promise<void>;
  /** running -> succeeded, stamping finishedAt. */
  markSucceeded(jobId: string): Promise<void>;
  /** running -> failed; the text is the outcome the status route shows. */
  markFailed(jobId: string, error: string): Promise<void>;
  /** One job by id, scoped to the bot (and so to the company boundary the
   *  route has already checked). Null for an unknown or foreign id. */
  getJob(input: { botId: string; jobId: string }): Promise<BotApplyJob | null>;
}

function rowToJob(row: typeof botApplyJobs.$inferSelect, created: boolean): BotApplyJob {
  return {
    id: row.id,
    companyId: row.companyId,
    botId: row.botId,
    status: row.status as BotApplyJobStatus,
    error: row.error,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    created,
  };
}

/** The store over the bot_apply_jobs table (packages/db schema). */
export function drizzleBotApplyJobStore(db: Db): BotApplyJobStore {
  const readLive = (botId: string) =>
    db
      .select()
      .from(botApplyJobs)
      .where(andLive(botId))
      .orderBy(desc(botApplyJobs.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

  return {
    async acquireLiveJob({ companyId, botId, requestedBy }) {
      // Close orphans first (see BOT_APPLY_JOB_STALE_MS): their failure text
      // stays visible through the status route, and the unique index frees up.
      await db
        .update(botApplyJobs)
        .set({ status: "failed", error: STALE_JOB_ERROR, finishedAt: new Date() })
        .where(
          and(
            eq(botApplyJobs.botId, botId),
            inArray(botApplyJobs.status, ["pending", "running"]),
            lt(botApplyJobs.createdAt, new Date(Date.now() - BOT_APPLY_JOB_STALE_MS)),
          ),
        );
      // Fast path: reuse the live job before paying for an insert.
      const existing = await readLive(botId);
      if (existing) return rowToJob(existing, false);
      try {
        const inserted = await db
          .insert(botApplyJobs)
          .values({ companyId, botId, status: "pending", requestedBy })
          .returning();
        const row = inserted[0];
        if (!row) throw new Error("bot_apply_jobs insert returned no row");
        return rowToJob(row, true);
      } catch (err) {
        // The race we are here for: another POST (or another api process)
        // inserted a live job for this bot between the read and the insert.
        // The partial unique index rejected us; hand back the winner's row.
        if (isUniqueViolation(err)) {
          const winner = await readLive(botId);
          if (winner) return rowToJob(winner, false);
        }
        throw err;
      }
    },

    async markRunning(jobId) {
      await db
        .update(botApplyJobs)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(botApplyJobs.id, jobId));
    },

    async markSucceeded(jobId) {
      await db
        .update(botApplyJobs)
        .set({ status: "succeeded", error: null, finishedAt: new Date() })
        .where(eq(botApplyJobs.id, jobId));
    },

    async markFailed(jobId, error) {
      await db
        .update(botApplyJobs)
        .set({ status: "failed", error, finishedAt: new Date() })
        .where(eq(botApplyJobs.id, jobId));
    },

    async getJob({ botId, jobId }) {
      // A malformed id is "no such job", not a database error (as in getAgent).
      if (!UUID_PATTERN.test(jobId)) return null;
      const row = await db
        .select()
        .from(botApplyJobs)
        .where(and(eq(botApplyJobs.id, jobId), eq(botApplyJobs.botId, botId)))
        .then((rows) => rows[0] ?? null);
      return row ? rowToJob(row, false) : null;
    },
  };
}

function andLive(botId: string) {
  return and(eq(botApplyJobs.botId, botId), inArray(botApplyJobs.status, ["pending", "running"]));
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}
