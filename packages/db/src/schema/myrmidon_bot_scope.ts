// packages/db/src/schema/myrmidon_bot_scope.ts
//
// myrmidon(BOT-DISK-F): isolation scope of a bot's disk. Four small tables:
//
//   - myrmidon_scope_groups         explicit named groups (a first-class entity,
//                                    renamed and deleted without a restart);
//   - myrmidon_scope_group_members  which agents are in which group (an agent may
//                                    be in many);
//   - myrmidon_scope_settings       one row per configured scope instance: the
//                                    kind (group, caste, subtree, project,
//                                    catalog, company), its id, and whether its
//                                    members are `isolated` or share one root;
//   - myrmidon_scope_agent_prefs    the agent level: keep isolated, the choice
//                                    between several groups / projects, and the
//                                    layout the board keeps the bot's container
//                                    on right now (`applied_*`). A scope change
//                                    shows up as "restart required" while the
//                                    effective layout differs from the applied one.
//
// The resolver that reads these rows is packages/shared/src/myrmidon-isolation-scope.ts.

import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index, primaryKey } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const myrmidonScopeGroups = pgTable(
  "myrmidon_scope_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUq: uniqueIndex("myrmidon_scope_groups_company_name_uq").on(table.companyId, table.name),
  }),
);

export const myrmidonScopeGroupMembers = pgTable(
  "myrmidon_scope_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => myrmidonScopeGroups.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.groupId, table.agentId], name: "myrmidon_scope_group_members_pk" }),
    agentIdx: index("myrmidon_scope_group_members_agent_idx").on(table.agentId),
  }),
);

export const myrmidonScopeSettings = pgTable(
  "myrmidon_scope_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** `group`, `caste`, `subtree`, `project`, `catalog` or `company`. */
    scopeKind: text("scope_kind").notNull(),
    /** Group id, role key, subtree root agent id, project id, catalog id; the company id for `company`. */
    scopeId: text("scope_id").notNull(),
    /** `isolated` (each member keeps its own disk) or `shared` (one root for the instance). */
    mode: text("mode").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    instanceUq: uniqueIndex("myrmidon_scope_settings_instance_uq").on(table.companyId, table.scopeKind, table.scopeId),
  }),
);

export const myrmidonScopeAgentPrefs = pgTable(
  "myrmidon_scope_agent_prefs",
  {
    agentId: uuid("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Keep this agent isolated whatever its groups, caste, subtree, project, catalog team or company say. */
    isolate: boolean("isolate").notNull().default(false),
    /** Which of several defining groups decides. No foreign key: a deleted group just stops matching. */
    groupId: uuid("group_id"),
    /** Which of several defining projects decides. */
    projectId: uuid("project_id"),
    /** Layout the board keeps the container on: `isolated` or `shared`. */
    appliedKind: text("applied_kind").notNull().default("isolated"),
    /** Directory name of the shared instance when `applied_kind` is `shared`. */
    appliedDir: text("applied_dir"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("myrmidon_scope_agent_prefs_company_idx").on(table.companyId),
  }),
);
