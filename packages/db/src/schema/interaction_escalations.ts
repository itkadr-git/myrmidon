import { pgTable, integer, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";

export const interactionEscalations = pgTable(
  "interaction_escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    interactionId: uuid("interaction_id").notNull().references(() => issueThreadInteractions.id, { onDelete: "cascade" }),
    level: integer("level").notNull(),
    fromRecipient: jsonb("from_recipient").notNull(),
    toRecipient: jsonb("to_recipient").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    interactionLevelUq: uniqueIndex("interaction_escalations_interaction_level_uq").on(table.interactionId, table.level),
    companyCreatedAtIdx: index("interaction_escalations_company_created_at_idx").on(table.companyId, table.createdAt),
  }),
);

export type InteractionEscalation = typeof interactionEscalations.$inferSelect;
export type NewInteractionEscalation = typeof interactionEscalations.$inferInsert;