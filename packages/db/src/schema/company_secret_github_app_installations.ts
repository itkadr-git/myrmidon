import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Encrypted GitHub App credentials used only to write repository Actions secrets. */
export const companySecretGitHubAppInstallations = pgTable(
  "company_secret_github_app_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    displayName: text("display_name").notNull(),
    appId: text("app_id").notNull(),
    privateKeyCiphertext: text("private_key_ciphertext").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("ready"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secret_github_app_installations_company_idx").on(table.companyId),
    companyInstallationUq: uniqueIndex("company_secret_github_app_installations_company_installation_uq").on(
      table.companyId,
      table.installationId,
    ),
  }),
);
