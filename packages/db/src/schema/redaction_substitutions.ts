import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const redactionSubstitutions = pgTable(
  "redaction_substitutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    redactionId: uuid("redaction_id").notNull(),
    token: text("token").notNull(),
    original: text("original").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("redaction_substitutions_lookup_idx").on(table.redactionId, table.token),
    expiryIdx: index("redaction_substitutions_expiry_idx").on(table.expiresAt),
  }),
);
