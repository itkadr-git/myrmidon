// packages/db/src/schema/agent_nests.ts
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the agent's nests — the projects an
// agent is willing to work in.
//
// One row per (agent, project) pair. The table answers ONE question for the
// matcher: which projects may this agent be matched into?
//
//  - no rows for the agent      -> the agent is a citizen of the whole company
//                                  and is eligible for every task;
//  - one or more rows           -> the agent is eligible only for tasks of
//                                  those projects, plus tasks that belong to no
//                                  project at all.
//
// The read is a fresh query on every matcher pass (no cache, no env), so
// editing the nests in the agent card changes the match without a restart.
//
// Additive migration only: one new table + indexes, no vendor table touched.

import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const agentNests = pgTable(
  "agent_nests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentProjectUq: uniqueIndex("agent_nests_agent_project_uq").on(
      table.agentId,
      table.projectId,
    ),
    companyAgentIdx: index("agent_nests_company_agent_idx").on(table.companyId, table.agentId),
    projectIdx: index("agent_nests_project_idx").on(table.projectId),
  }),
);