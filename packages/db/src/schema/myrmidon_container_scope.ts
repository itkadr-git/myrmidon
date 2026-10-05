// packages/db/src/schema/myrmidon_container_scope.ts
//
// myrmidon(CONTAINER-SCOPE): the container axis of an isolation area. Two
// additive tables, next to the disk axis of BOT-DISK-F
// (myrmidon_bot_scope.ts) — the disk tables stay untouched:
//
//   - myrmidon_container_settings  one row per scope instance: whether its
//                                  members run in one container (`per-scope`) or
//                                  each in its own (`per-agent`, the default);
//   - myrmidon_container_states    the container an agent runs in right now and
//                                  the "restart required" marker, written by the
//                                  recompute and cleared by the runtime.
//
// The planner that reads these rows is
// packages/shared/src/myrmidon-container-scope.ts.

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const myrmidonContainerSettings = pgTable(
  "myrmidon_container_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** `group`, `caste`, `subtree`, `project`, `catalog` or `company`. */
    scopeKind: text("scope_kind").notNull(),
    /** Group id, role key, subtree root agent id, project id, catalog id; the company id for `company`. */
    scopeId: text("scope_id").notNull(),
    /** `per-agent` (one container each) or `per-scope` (one container for the instance). */
    containerMode: text("container_mode").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    instanceUq: uniqueIndex("myrmidon_container_settings_instance_uq").on(
      table.companyId,
      table.scopeKind,
      table.scopeId,
    ),
  }),
);

export const myrmidonContainerStates = pgTable(
  "myrmidon_container_states",
  {
    agentId: uuid("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The container the runtime reports for this agent; null before the first apply. */
    appliedContainerKey: text("applied_container_key"),
    /** Set while the agent's container is not the one its area asks for. */
    restartRequiredAt: timestamp("restart_required_at", { withTimezone: true }),
    restartReason: text("restart_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("myrmidon_container_states_company_idx").on(table.companyId),
  }),
);