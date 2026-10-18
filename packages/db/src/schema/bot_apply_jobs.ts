// packages/db/src/schema/bot_apply_jobs.ts
//
// myrmidon(1.6.5 ASYNC-BOT-APPLY): the journal of "Apply now" requests for a
// bot container. The apply button used to hold its HTTP request for the whole
// reconcile pass (~36 s on a cold restart; facts §6.3); the pass now runs in
// the background of the same process and every request lands as one row here.
//
// One row per apply request: `status` walks pending -> running -> succeeded |
// failed, and the final outcome (including the failure text) is readable from
// the database, so the board UI can poll the status route instead of waiting
// on the socket. Idempotency lives in the store: while a bot has a live
// (pending/running) row, a repeated POST returns that row instead of inserting
// a second one.
//
// Additive migration only: one new table + indexes; no vendor table touched.

import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/** The status vocabulary of an apply job; mirrored by the server store. */
export const BOT_APPLY_JOB_STATUSES = ["pending", "running", "succeeded", "failed"] as const;
export type BotApplyJobStatus = (typeof BOT_APPLY_JOB_STATUSES)[number];

export const botApplyJobs = pgTable(
  "bot_apply_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** pending | running | succeeded | failed — see BOT_APPLY_JOB_STATUSES. */
    status: text("status").notNull().default("pending"),
    /** The failure text once the background pass ended in error; null otherwise. */
    error: text("error"),
    /** The board user who pressed "Apply now" (their actor id), when known. */
    requestedBy: text("requested_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the background pass picked the job up; null while pending. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** When the pass finished (succeeded or failed); null until then. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    /** The status route's read (one job by id within a company). */
    companyBotIdx: index("bot_apply_jobs_company_bot_idx").on(table.companyId, table.botId),
    /** Idempotency at the database level: one LIVE (pending/running) job per bot,
     *  so two racing POSTs cannot both insert; the loser re-reads the winner. */
    liveJobUniq: uniqueIndex("bot_apply_jobs_live_bot_uniq")
      .on(table.botId)
      .where(sql`${table.status} in ('pending', 'running')`),
  }),
);
