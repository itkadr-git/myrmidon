import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, bigint, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * myrmidon(1.6.6 C-MEM): the journal of the memory sync of execution sites (remote-sites-v2, C-MEM).
 *
 * The primary work-memory of a remote site lives on the site (hindsight-work). The board keeps a
 * replica of it in the `fleet-work-replica` bank. One row is one sync attempt of one site:
 * `kind` is `nightly` (the lane), `forced` (right before a bot move) or `manual`. A row starts as
 * `running` and ends as `ok` or `failed`; a failed attempt is retried by the lane (the catch-up),
 * and the import skips documents the replica already has, so a retry never duplicates them.
 */
export const myrmidonFleetMemorySyncs = pgTable(
  "myrmidon_fleet_memory_syncs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    siteName: text("site_name").notNull(),
    // "nightly" | "forced" | "manual"
    kind: text("kind").notNull(),
    // "running" | "ok" | "failed"
    status: text("status").notNull().default("running"),
    targetBank: text("target_bank").notNull(),
    botKey: text("bot_key"),
    moveId: uuid("move_id"),
    archiveBytes: bigint("archive_bytes", { mode: "number" }),
    documentsImported: integer("documents_imported"),
    documentsSkipped: integer("documents_skipped"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    siteStartedIdx: index("myrmidon_fleet_memory_syncs_site_started_idx").on(table.companyId, table.siteName, table.startedAt),
    // At most one running sync per site: the claim is this index, so two board processes cannot
    // both pull the same site's memory at once.
    runningSiteUq: uniqueIndex("myrmidon_fleet_memory_syncs_running_site_uq")
      .on(table.companyId, table.siteName)
      .where(sql`${table.status} = 'running'`),
  }),
);

export const fleetMemorySyncs = myrmidonFleetMemorySyncs;
