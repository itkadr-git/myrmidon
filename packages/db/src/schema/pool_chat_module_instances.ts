import { pgTable, text, timestamp, uniqueIndex, uuid, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

// myrmidon(1.6.6 POOL-CHAT-INSTANCE): durable, company-scoped module identity
// and non-secret provider routing configuration. Credentials remain in the
// secret store and are referenced by name only.
export const poolChatModuleInstances = pgTable(
  "pool_chat_module_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    moduleKey: text("module_key").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("active"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    credentialSecretName: text("credential_secret_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyModuleUniqueIdx: uniqueIndex("pool_chat_module_instances_company_module_uq").on(
      table.companyId,
      table.moduleKey,
    ),
    companyIdx: index("pool_chat_module_instances_company_idx").on(table.companyId),
    projectIdx: index("pool_chat_module_instances_project_idx").on(table.projectId),
  }),
);
