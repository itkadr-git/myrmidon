// myrmidon(OPE-13026): persistence for external-connector per-agent action
// policy and the append-only invocation audit journal (OPE-12992 ч.3/ч.4).
//
// Three tables:
//   - external_connector_policy_grants: agent × connector × action grants with
//     mode read/write/confirm/deny (no grant ⇒ fail closed);
//   - external_connector_invocations: append-only journal of every attempted
//     call — actor, connector, action, timestamp, outcome, reason (the rights
//     screen journal in OPE-13029 reads these rows; the rows are never
//     updated or deleted by the enforcement layer);
//   - external_connector_pending_approvals: approval-pending state for calls
//     whose mode requires human confirmation — the pending call is stored
//     here and does NOT reach the connector until a human resolves it.
//
// Journal append-only rule: the enforcement service only INSERTs into
// external_connector_invocations; UPDATE/DELETE stay outside the service and
// the API (the append-only criterion in OPE-13026).

import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents, companies } from "./index.js";
import type {
  ConnectorPolicyGrantMode,
  ConnectorInvocationOutcome,
  ConnectorPendingApprovalStatus,
} from "@myrmidon/shared";

export const externalConnectorPolicyGrants = pgTable(
  "external_connector_policy_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    /** Kebab-case connector slug from the shared catalog contract. */
    connectorId: text("connector_id").notNull(),
    /** Catalog action id or `*` for the connector-wide scope. */
    actionId: text("action_id").notNull(),
    mode: text("mode").$type<ConnectorPolicyGrantMode>().notNull(),
    /** `agent:<uuid>` or `user:<id>` — who created/last updated the grant. */
    createdBy: text("created_by").notNull(),
    /** False rows stay in the table for the audit trail but never match. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One grant per (company, agent, connector, action scope).
    uniqueIndex("external_connector_policy_grants_uq").on(
      table.companyId,
      table.agentId,
      table.connectorId,
      table.actionId,
    ),
    index("external_connector_policy_grants_lookup_idx").on(
      table.companyId,
      table.agentId,
      table.enabled,
    ),
  ],
);

export const externalConnectorInvocations = pgTable(
  "external_connector_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** `agent` or `user`. */
    actorType: text("actor_type").notNull(),
    /** Agent uuid or board user id. */
    actorId: text("actor_id").notNull(),
    /** Foreign key to the agent when actorType=agent; kept for the journal filter. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    connectorId: text("connector_id").notNull(),
    actionId: text("action_id").notNull(),
    grantMode: text("grant_mode").$type<ConnectorPolicyGrantMode>(),
    outcome: text("outcome").$type<ConnectorInvocationOutcome>().notNull(),
    /** Machine-readable reason: no_grant, mode_denied, requires_confirmation, ... */
    reason: text("reason").notNull(),
    /** Present while outcome=pending_confirmation. */
    pendingApprovalId: uuid("pending_approval_id"),
    /** Redacted payload summary for the rights screen (never raw secrets). */
    payloadSummary: text("payload_summary"),
    /** Caller-supplied correlation id (issue/run linkage), optional. */
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("external_connector_invocations_company_created_idx").on(
      table.companyId,
      table.createdAt.desc(),
    ),
    index("external_connector_invocations_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt.desc(),
    ),
    index("external_connector_invocations_company_connector_created_idx").on(
      table.companyId,
      table.connectorId,
      table.createdAt.desc(),
    ),
  ],
);

export const externalConnectorPendingApprovals = pgTable(
  "external_connector_pending_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** The pending_confirmation journal row this approval belongs to. */
    invocationId: uuid("invocation_id")
      .notNull()
      .references(() => externalConnectorInvocations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    connectorId: text("connector_id").notNull(),
    actionId: text("action_id").notNull(),
    status: text("status").$type<ConnectorPendingApprovalStatus>().notNull().default("pending"),
    /** Full original call request (actor, connectorId, actionId, payload). */
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    requestedBy: text("requested_by").notNull(),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Payload redacted the same way as the journal row, for screen views. */
    payloadSummary: text("payload_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("external_connector_pending_approvals_company_status_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    index("external_connector_pending_approvals_invocation_idx").on(
      table.invocationId,
      sql`${table.status} = 'pending'`,
    ),
    uniqueIndex("external_connector_pending_approvals_invocation_uq").on(table.invocationId),
  ],
);
