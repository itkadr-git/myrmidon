import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const legacyBlockedImports = pgTable(
  "legacy_blocked_import",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    importKey: text("import_key").notNull(),
    issueId: uuid("issue_id").notNull(),
    class: text("class").notNull(),
    resultIssueId: uuid("result_issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyImportKeyUq: unique("legacy_blocked_import_company_import_key_uq").on(table.companyId, table.importKey),
    issueCompanyUq: unique("legacy_blocked_import_issue_company_fk").on(table.companyId, table.issueId),
    issueIdIdx: index("legacy_blocked_import_issue_id_idx").on(table.issueId),
  }),
);