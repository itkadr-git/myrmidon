import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export interface FleetMovePhaseLogEntry {
  phase: string;
  at: string;
  details?: string;
  error?: string;
}

/**
 * myrmidon(1.6.6 REMOTE-SITES-T5): fleet bot moves state machine.
 *
 * Tracks live bot migration across execution sites:
 * stop -> snapshot -> restore -> host -> reconcile -> apiBaseUrl -> quarantine
 *
 * Idempotent: resuming a failed/interrupted move continues from the last completed phase.
 */
export const myrmidonFleetMoves = pgTable(
  "myrmidon_fleet_moves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    botKey: text("bot_key").notNull(),
    srcSite: text("src_site").notNull(),
    dstSite: text("dst_site").notNull(),
    phase: text("phase").notNull(), // "init" | "stop" | "snapshot" | "restore" | "host" | "reconcile" | "apiBaseUrl" | "quarantine" | "done" | "failed"
    phaseLog: jsonb("phase_log").$type<FleetMovePhaseLogEntry[]>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    leaseExpires: timestamp("lease_expires", { withTimezone: true }),
    error: text("error"),
    // myrmidon(1.6.6 REMOTE-SITES-T4): "live" reads the source datadir; "replica" restores the
    // last replica because the source site is lost.
    source: text("source").notNull().default("live"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBotIdx: index("myrmidon_fleet_moves_company_bot_idx").on(table.companyId, table.botKey),
    phaseIdx: index("myrmidon_fleet_moves_phase_idx").on(table.phase),
    // myrmidon(1.6.6 REMOTE-SITES-T4): a bot has at most one unfinished move. The claim is this
    // index, not a read-then-insert, so two board processes cannot both start a move of one bot.
    activeBotUq: uniqueIndex("myrmidon_fleet_moves_active_bot_uq")
      .on(table.companyId, table.botKey)
      .where(sql`${table.phase} NOT IN ('done', 'failed')`),
  }),
);
