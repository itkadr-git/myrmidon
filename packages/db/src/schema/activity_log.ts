import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    responsibleUserId: text("responsible_user_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    companyAgentCreatedIdx: index("activity_log_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    companyResponsibleUserCreatedIdx: index("activity_log_company_responsible_user_created_idx").on(
      table.companyId,
      table.responsibleUserId,
      table.createdAt,
    ),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    entityIdx: index("activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
    // myrmidon(DB-CARE): the attention feed resolves the issues whose assignee
    // left one agent by reading the audit rows' previous-assignee payload
    // (server/src/services/attention.ts, details->'_previous'). Persisted from
    // the production database, see migration 0309_db_care_issue_prev_assignee_index.
    issuePrevAssigneeIdx: index("activity_log_issue_prev_assignee_idx")
      .on(
        table.companyId,
        sql`((${table.details} -> '_previous' ->> 'assigneeAgentId'))`,
        table.createdAt,
      )
      .where(sql`${table.entityType} = 'issue' and ${table.action} = 'issue.updated'`),
    // myrmidon(DB-CARE): the issue activity view reads the audit rows of one
    // issue (company + entity_id) newest-first and skips the read/inbox marker
    // actions, so the index is partial on "not a marker". Persisted from the
    // production database, see migration 0310_db_care_audit_indexes.
    issueLastActivityIdx: index("activity_log_issue_last_activity_idx")
      .on(table.companyId, table.entityId, table.createdAt.desc())
      .where(
        sql`${table.entityType} = 'issue' and ${table.action} <> ALL (ARRAY['issue.read_marked', 'issue.read_unmarked', 'issue.inbox_archived', 'issue.inbox_unarchived'])`,
      ),
  }),
);
