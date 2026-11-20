import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { acceptanceServiceCredentials } from "./acceptance_service_credentials.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const nativeFinalizationGrants = pgTable("native_finalization_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  runId: uuid("run_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  credentialId: uuid("credential_id").notNull().references(() => acceptanceServiceCredentials.id),
  certificateSha256: text("certificate_sha256").notNull(),
  generation: integer("generation").notNull().default(1),
  notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdByOperatorId: text("created_by_operator_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runUnique: unique("native_finalization_grants_run_uq").on(table.runId),
  ownerUnique: unique("native_finalization_grants_owner_uq").on(table.companyId, table.issueId, table.runId, table.id),
  runOwner: foreignKey({ columns: [table.companyId, table.issueId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.nativeIssueId, heartbeatRuns.id], name: "native_finalization_grants_run_owner_fk" }),
  issueOwner: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id], name: "native_finalization_grants_issue_owner_fk" }),
  generationCheck: check("native_finalization_grants_generation_check", sql`${table.generation} > 0`),
}));

export const nativeFinalizationRequests = pgTable("native_finalization_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  runId: uuid("run_id").notNull(),
  grantId: uuid("grant_id").notNull(),
  grantGeneration: integer("grant_generation").notNull(),
  principalId: uuid("principal_id").notNull(),
  credentialId: uuid("credential_id").notNull().references(() => acceptanceServiceCredentials.id),
  verifiedPeerSha256: text("verified_peer_sha256").notNull(),
  authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull(),
  documentId: uuid("document_id").notNull(),
  expectedRevisionId: uuid("expected_revision_id").notNull(),
  expectedIssueEpoch: text("expected_issue_epoch").notNull(),
  strongEtag: text("strong_etag").notNull(),
  canonicalPayloadHash: text("canonical_payload_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  state: text("state").notNull().default("accepted"),
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  resultDecisionId: uuid("result_decision_id"),
  errorCode: text("error_code"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  grantOwner: foreignKey({ columns: [table.companyId, table.issueId, table.runId, table.grantId], foreignColumns: [nativeFinalizationGrants.companyId, nativeFinalizationGrants.issueId, nativeFinalizationGrants.runId, nativeFinalizationGrants.id], name: "native_finalization_requests_grant_owner_fk" }),
  replayUnique: unique("native_finalization_requests_replay_uq").on(table.credentialId, table.runId, table.idempotencyKey),
  activeRun: uniqueIndex("native_finalization_requests_active_run_uq").on(table.runId).where(sql`${table.state} in ('accepted', 'processing')`),
  stateCheck: check("native_finalization_requests_state_check", sql`${table.state} in ('accepted', 'processing', 'committed', 'rejected')`),
}));

export const nativeFinalizationOutbox = pgTable("native_finalization_outbox", {
  requestId: uuid("request_id").primaryKey().references(() => nativeFinalizationRequests.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
}, (table) => ({ pending: index("native_finalization_outbox_pending_idx").on(table.createdAt).where(sql`${table.dispatchedAt} is null`) }));
