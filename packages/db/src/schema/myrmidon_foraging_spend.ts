// myrmidon(1.6.1-FORAGING-LIMITS-UI): the spend ledger of the learning sweep.
//
// One additive table, no vendor table is touched:
//  - foraging_spend_events: one row per source read, with the cost estimate
//    the pass priced it at, the role and the agent of the registry row, the
//    source url and the read outcome. The limit windows (day, month, per
//    role, per agent) are plain queries over this table; the Costs screens
//    get the same spend as one `training_charge` finance event per pass (the
//    vendor finance_events table the Costs screen already renders by kind).
//
// Rollback restores the image, not the database: an older image ignores the
// table, which is why it is additive only.

import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { foragingSources } from "./myrmidon_foraging.js";

/** How one read ended, kept in sync with the domain's read outcomes. */
export type ForagingSpendOutcome = "changed" | "unchanged" | "baseline" | "failed";

export const foragingSpendEvents = pgTable(
  "foraging_spend_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => foragingSources.id, { onDelete: "cascade" }),
    /** The agent role of the registry row (`agents.role`, the caste). */
    role: text("role").notNull(),
    /** The agent the learning feeds, when the company resolved one; else null. */
    agentId: uuid("agent_id"),
    /** The url as the registry row stores it (the "source" of the Costs line). */
    url: text("url").notNull(),
    /** The cost estimate the pass priced this read at, in cents. */
    costCents: integer("cost_cents").notNull(),
    /** How the read ended. */
    outcome: text("outcome").$type<ForagingSpendOutcome>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("foraging_spend_company_occurred_idx").on(
      table.companyId,
      table.occurredAt,
    ),
    companyRoleIdx: index("foraging_spend_company_role_idx").on(table.companyId, table.role),
    companyAgentIdx: index("foraging_spend_company_agent_idx").on(
      table.companyId,
      table.agentId,
      table.occurredAt,
    ),
    sourceIdx: index("foraging_spend_source_idx").on(table.sourceId),
  }),
);
