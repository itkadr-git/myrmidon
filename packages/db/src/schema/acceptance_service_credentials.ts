import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const acceptanceServiceCredentials = pgTable(
  "acceptance_service_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    audience: text("audience").notNull(),
    keyHash: text("key_hash").notNull(),
    certificateSha256: text("certificate_sha256").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({ keyHashIdx: index("acceptance_service_credentials_key_hash_idx").on(table.keyHash) }),
);
