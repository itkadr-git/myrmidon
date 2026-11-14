// myrmidon(OPE-13026): external MCP connector per-agent action policy and
// invocation audit enforcement service (OPE-12992 ч.3/ч.4).
//
// Responsibilities:
//   1. Grant management (agent x connector x action scope: read/write/confirm/deny).
//   2. Pre-dispatch authorization enforcement: no grant ⇒ fail closed (deny),
//      read-only grant ⇒ write/confirm denied before dispatch, confirm grant or
//      action mode confirm ⇒ approval-pending state (no external dispatch).
//   3. Append-only invocation journal: every attempted call writes an immutable
//      record (actor, connector, action, timestamp, outcome, reason). The service
//      never updates or deletes journal rows.
//   4. Pending approval resolution: human approves (dispatches call + logs
//      approved_dispatch) or rejects (logs denied_rejected_approval).
//   5. Journal query contract with filtering and pagination.

import { type Db } from "@myrmidon/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  externalConnectorInvocations,
  externalConnectorPendingApprovals,
  externalConnectorPolicyGrants,
  agents,
} from "@myrmidon/db";
import {
  connectorModeAllowsDispatch,
  resolveConnectorPolicyMode,
  type ConnectorActionMode,
  type ConnectorInvocationDispatchResult,
  type ConnectorInvocationEnforcement,
  type ConnectorInvocationJournalEntry,
  type ConnectorInvocationJournalPage,
  type ConnectorInvocationJournalQuery,
  type ConnectorInvocationOutcome,
  type ConnectorPendingApproval,
  type ConnectorPendingApprovalStatus,
  type ConnectorPolicyGrant,
  type ConnectorPolicyGrantMode,
  type InvokeConnectorActionRequest,
  type ListConnectorPolicyGrantsQuery,
  type PutConnectorPolicyGrantsRequest,
} from "@myrmidon/shared";
import { conflict, notFound } from "../../errors.js";

// ---------------------------------------------------------------------------
// Redaction helper for the rights screen journal
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN = /(?:key|secret|token|password|auth|bearer|credential|cert|signature)/i;

/**
 * Summarize payload for the audit journal, strictly redacting secret-shaped keys
 * and truncating to at most 2000 characters.
 */
export function summarizePayload(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  try {
    const redacted = sanitizeValue(payload);
    const json = JSON.stringify(redacted);
    if (!json) return null;
    return json.length > 2000 ? json.slice(0, 1997) + "..." : json;
  } catch {
    return "[unserializable payload]";
  }
}

function sanitizeValue(val: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested]";
  if (val === null || val === undefined) return val;
  if (typeof val !== "object") return val;
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeValue(item, depth + 1));
  }
  const obj = val as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = sanitizeValue(v, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connector action mode catalog resolver
// ---------------------------------------------------------------------------

export type ConnectorActionModeResolver = (
  connectorId: string,
  actionId: string,
) => Promise<ConnectorActionMode | null> | ConnectorActionMode | null;

/** Default resolver assumes catalog action modes follow a read/write heuristic when no catalog is injected. */
export const defaultActionModeResolver: ConnectorActionModeResolver = (_connectorId, actionId) => {
  const lower = actionId.toLowerCase();
  if (lower.includes("delete") || lower.includes("destroy") || lower.includes("purge") || lower.includes("admin")) {
    return "confirm";
  }
  if (
    lower.includes("create") ||
    lower.includes("update") ||
    lower.includes("write") ||
    lower.includes("set") ||
    lower.includes("send") ||
    lower.includes("post")
  ) {
    return "write";
  }
  return "read";
};

// ---------------------------------------------------------------------------
// External connector dispatcher contract
// ---------------------------------------------------------------------------

export type ConnectorDispatcher = (
  req: InvokeConnectorActionRequest,
) => Promise<ConnectorInvocationDispatchResult>;

// ---------------------------------------------------------------------------
// Store interface decoupling service domain logic from direct drizzle calls
// ---------------------------------------------------------------------------

export interface ExternalConnectorGrantRow {
  id: string;
  companyId: string;
  agentId: string;
  connectorId: string;
  actionId: string;
  mode: ConnectorPolicyGrantMode;
  createdBy: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExternalConnectorInvocationRow {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string;
  agentId: string | null;
  connectorId: string;
  actionId: string;
  grantMode: ConnectorPolicyGrantMode | null;
  outcome: ConnectorInvocationOutcome;
  reason: string;
  pendingApprovalId: string | null;
  payloadSummary: string | null;
  correlationId: string | null;
  createdAt: Date;
}

export interface ExternalConnectorPendingApprovalRow {
  id: string;
  companyId: string;
  invocationId: string;
  agentId: string;
  connectorId: string;
  actionId: string;
  status: ConnectorPendingApprovalStatus;
  request: Record<string, unknown>;
  requestedBy: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  payloadSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorPolicyStore {
  agentExists(companyId: string, agentId: string): Promise<boolean>;
  listGrants(companyId: string, query: ListConnectorPolicyGrantsQuery): Promise<ExternalConnectorGrantRow[]>;
  replaceGrants(
    companyId: string,
    agentId: string,
    connectorId: string,
    createdBy: string,
    grants: Array<{ actionId: string; mode: ConnectorPolicyGrantMode }>,
  ): Promise<ExternalConnectorGrantRow[]>;
  insertInvocation(row: Omit<ExternalConnectorInvocationRow, "id" | "createdAt">): Promise<ExternalConnectorInvocationRow>;
  insertPendingApproval(
    row: Omit<ExternalConnectorPendingApprovalRow, "id" | "createdAt" | "updatedAt">,
  ): Promise<ExternalConnectorPendingApprovalRow>;
  findPendingApproval(companyId: string, id: string): Promise<ExternalConnectorPendingApprovalRow | null>;
  resolvePendingApproval(
    companyId: string,
    id: string,
    status: "approved" | "rejected",
    resolvedBy: string,
    resolvedAt: Date,
  ): Promise<ExternalConnectorPendingApprovalRow | null>;
  listPendingApprovals(companyId: string, status?: ConnectorPendingApprovalStatus): Promise<ExternalConnectorPendingApprovalRow[]>;
  queryJournal(
    companyId: string,
    query: ConnectorInvocationJournalQuery,
  ): Promise<{ rows: ExternalConnectorInvocationRow[]; total: number }>;
}

// ---------------------------------------------------------------------------
// Drizzle store implementation
// ---------------------------------------------------------------------------

export function createDrizzleConnectorPolicyStore(db: Db): ConnectorPolicyStore {
  return {
    async agentExists(companyId: string, agentId: string): Promise<boolean> {
      const row = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
        .limit(1)
        .then((r) => r[0] ?? null);
      return Boolean(row);
    },

    async listGrants(companyId: string, query: ListConnectorPolicyGrantsQuery): Promise<ExternalConnectorGrantRow[]> {
      const conds = [
        eq(externalConnectorPolicyGrants.companyId, companyId),
        eq(externalConnectorPolicyGrants.enabled, true),
      ];
      if (query.agentId) conds.push(eq(externalConnectorPolicyGrants.agentId, query.agentId));
      if (query.connectorId) conds.push(eq(externalConnectorPolicyGrants.connectorId, query.connectorId));

      const rows = await db
        .select()
        .from(externalConnectorPolicyGrants)
        .where(and(...conds))
        .orderBy(desc(externalConnectorPolicyGrants.updatedAt));
      return rows as ExternalConnectorGrantRow[];
    },

    async replaceGrants(companyId, agentId, connectorId, createdBy, grants) {
      return db.transaction(async (tx) => {
        // Disable pre-existing grants for this (company, agent, connector) tuple
        await tx
          .delete(externalConnectorPolicyGrants)
          .where(
            and(
              eq(externalConnectorPolicyGrants.companyId, companyId),
              eq(externalConnectorPolicyGrants.agentId, agentId),
              eq(externalConnectorPolicyGrants.connectorId, connectorId),
            ),
          );

        if (grants.length === 0) return [];

        const now = new Date();
        const inserts = grants.map((g) => ({
          companyId,
          agentId,
          connectorId,
          actionId: g.actionId,
          mode: g.mode,
          createdBy,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        }));

        const inserted = await tx
          .insert(externalConnectorPolicyGrants)
          .values(inserts)
          .returning();
        return inserted as ExternalConnectorGrantRow[];
      });
    },

    async insertInvocation(row) {
      const inserted = await db
        .insert(externalConnectorInvocations)
        .values({
          ...row,
          agentId: row.agentId ?? null,
          grantMode: row.grantMode ?? null,
          pendingApprovalId: row.pendingApprovalId ?? null,
          payloadSummary: row.payloadSummary ?? null,
          correlationId: row.correlationId ?? null,
        })
        .returning();
      return inserted[0] as ExternalConnectorInvocationRow;
    },

    async insertPendingApproval(row) {
      const inserted = await db
        .insert(externalConnectorPendingApprovals)
        .values({
          ...row,
          resolvedBy: row.resolvedBy ?? null,
          resolvedAt: row.resolvedAt ?? null,
          payloadSummary: row.payloadSummary ?? null,
        })
        .returning();
      return inserted[0] as ExternalConnectorPendingApprovalRow;
    },

    async findPendingApproval(companyId, id) {
      const row = await db
        .select()
        .from(externalConnectorPendingApprovals)
        .where(
          and(
            eq(externalConnectorPendingApprovals.companyId, companyId),
            eq(externalConnectorPendingApprovals.id, id),
          ),
        )
        .limit(1)
        .then((r) => r[0] ?? null);
      return (row as ExternalConnectorPendingApprovalRow) ?? null;
    },

    async resolvePendingApproval(companyId, id, status, resolvedBy, resolvedAt) {
      const updated = await db
        .update(externalConnectorPendingApprovals)
        .set({
          status,
          resolvedBy,
          resolvedAt,
          updatedAt: resolvedAt,
        })
        .where(
          and(
            eq(externalConnectorPendingApprovals.companyId, companyId),
            eq(externalConnectorPendingApprovals.id, id),
            eq(externalConnectorPendingApprovals.status, "pending"),
          ),
        )
        .returning();
      return (updated[0] as ExternalConnectorPendingApprovalRow) ?? null;
    },

    async listPendingApprovals(companyId, status) {
      const conds = [eq(externalConnectorPendingApprovals.companyId, companyId)];
      if (status) conds.push(eq(externalConnectorPendingApprovals.status, status));
      const rows = await db
        .select()
        .from(externalConnectorPendingApprovals)
        .where(and(...conds))
        .orderBy(desc(externalConnectorPendingApprovals.createdAt));
      return rows as ExternalConnectorPendingApprovalRow[];
    },

    async queryJournal(companyId, query) {
      const conds = [eq(externalConnectorInvocations.companyId, companyId)];
      if (query.agentId) conds.push(eq(externalConnectorInvocations.agentId, query.agentId));
      if (query.connectorId) conds.push(eq(externalConnectorInvocations.connectorId, query.connectorId));
      if (query.actionId) conds.push(eq(externalConnectorInvocations.actionId, query.actionId));
      if (query.outcome) conds.push(eq(externalConnectorInvocations.outcome, query.outcome));
      if (query.from) conds.push(gte(externalConnectorInvocations.createdAt, new Date(query.from)));
      if (query.to) conds.push(lte(externalConnectorInvocations.createdAt, new Date(query.to)));

      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;

      const [rows, countResult] = await Promise.all([
        db
          .select()
          .from(externalConnectorInvocations)
          .where(and(...conds))
          .orderBy(desc(externalConnectorInvocations.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(externalConnectorInvocations)
          .where(and(...conds))
          .then((r) => r[0]?.count ?? 0),
      ]);

      return {
        rows: rows as ExternalConnectorInvocationRow[],
        total: Number(countResult),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// External connector policy service
// ---------------------------------------------------------------------------

export interface ExternalConnectorServiceOptions {
  store?: ConnectorPolicyStore;
  actionModeResolver?: ConnectorActionModeResolver;
}

export function externalConnectorService(db: Db, opts: ExternalConnectorServiceOptions = {}) {
  const store = opts.store ?? createDrizzleConnectorPolicyStore(db);
  const resolveActionMode = opts.actionModeResolver ?? defaultActionModeResolver;

  function toGrantDto(row: ExternalConnectorGrantRow): ConnectorPolicyGrant {
    return {
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      connectorId: row.connectorId,
      actionId: row.actionId,
      mode: row.mode,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  function toJournalDto(row: ExternalConnectorInvocationRow): ConnectorInvocationJournalEntry {
    return {
      id: row.id,
      companyId: row.companyId,
      actorType: row.actorType as "agent" | "user",
      actorId: row.actorId,
      connectorId: row.connectorId,
      actionId: row.actionId,
      grantMode: row.grantMode,
      outcome: row.outcome,
      reason: row.reason,
      pendingApprovalId: row.pendingApprovalId,
      payloadSummary: row.payloadSummary,
      createdAt: row.createdAt.toISOString(),
    };
  }

  function toApprovalDto(row: ExternalConnectorPendingApprovalRow): ConnectorPendingApproval {
    return {
      id: row.id,
      companyId: row.companyId,
      invocationId: row.invocationId,
      agentId: row.agentId,
      connectorId: row.connectorId,
      actionId: row.actionId,
      status: row.status,
      requestedBy: row.requestedBy,
      resolvedBy: row.resolvedBy,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  return {
    /** List active grants matching optional filters. */
    async listGrants(companyId: string, query: ListConnectorPolicyGrantsQuery = {}): Promise<ConnectorPolicyGrant[]> {
      const rows = await store.listGrants(companyId, query);
      return rows.map(toGrantDto);
    },

    /** Atomic replacement of grants for an (agentId, connectorId) pair. */
    async putGrants(
      companyId: string,
      req: PutConnectorPolicyGrantsRequest,
      actor: { actorId: string; actorType: string },
    ): Promise<ConnectorPolicyGrant[]> {
      const exists = await store.agentExists(companyId, req.agentId);
      if (!exists) throw notFound("Agent not found in company");

      const createdBy = `${actor.actorType}:${actor.actorId}`;
      const rows = await store.replaceGrants(companyId, req.agentId, req.connectorId, createdBy, req.grants);
      return rows.map(toGrantDto);
    },

    /**
     * Authorize and invoke a connector action server-side.
     * Enforces fail-closed semantics:
     *   - Missing grant ⇒ denied before dispatch + journal entry.
     *   - Deny mode ⇒ denied before dispatch + journal entry.
     *   - Read grant on write/confirm action ⇒ denied before dispatch + journal entry.
     *   - Confirm grant or confirm action mode ⇒ approval-pending state (no external dispatch) + journal entry.
     *   - Allowed ⇒ dispatched + journal entry.
     */
    async invoke(
      companyId: string,
      req: InvokeConnectorActionRequest,
      dispatcher: ConnectorDispatcher,
      actorOverride?: { actorType: "agent" | "user"; actorId: string },
    ): Promise<ConnectorInvocationEnforcement> {
      const actorType = actorOverride?.actorType ?? req.actor.type;
      const actorId = actorOverride?.actorId ?? req.actor.id;
      const payloadSummary = summarizePayload(req.payload);

      // Connectors are an agent-facing capability; non-agent actors fail closed with an audit record
      if (actorType !== "agent") {
        const invocation = await store.insertInvocation({
          companyId,
          actorType,
          actorId,
          agentId: null,
          connectorId: req.connectorId,
          actionId: req.actionId,
          grantMode: null,
          outcome: "denied",
          reason: "actor_type_not_supported",
          pendingApprovalId: null,
          payloadSummary,
          correlationId: null,
        });
        return { decision: "denied", journalEntry: toJournalDto(invocation) };
      }

      const agentId = actorId;

      // Verify agent exists
      const exists = await store.agentExists(companyId, agentId);
      if (!exists) {
        const invocation = await store.insertInvocation({
          companyId,
          actorType,
          actorId,
          agentId,
          connectorId: req.connectorId,
          actionId: req.actionId,
          grantMode: null,
          outcome: "denied",
          reason: "agent_not_found",
          pendingApprovalId: null,
          payloadSummary,
          correlationId: null,
        });
        return { decision: "denied", journalEntry: toJournalDto(invocation) };
      }

      // 1. Resolve action mode from catalog
      const actionMode = await resolveActionMode(req.connectorId, req.actionId);
      if (!actionMode) {
        const invocation = await store.insertInvocation({
          companyId,
          actorType,
          actorId,
          agentId,
          connectorId: req.connectorId,
          actionId: req.actionId,
          grantMode: null,
          outcome: "denied",
          reason: "action_not_found",
          pendingApprovalId: null,
          payloadSummary,
          correlationId: null,
        });
        return { decision: "denied", journalEntry: toJournalDto(invocation) };
      }

      // 2. Fetch grants for this agent/connector
      const grants = await store.listGrants(companyId, { agentId, connectorId: req.connectorId });
      const effectiveGrantMode: ConnectorPolicyGrantMode | null = resolveConnectorPolicyMode(
        grants,
        req.actionId,
      );

      // No grant ⇒ fail closed (deny)
      if (!effectiveGrantMode) {
        const invocation = await store.insertInvocation({
          companyId,
          actorType,
          actorId,
          agentId,
          connectorId: req.connectorId,
          actionId: req.actionId,
          grantMode: null,
          outcome: "denied",
          reason: "no_grant",
          pendingApprovalId: null,
          payloadSummary,
          correlationId: null,
        });
        return { decision: "denied", journalEntry: toJournalDto(invocation) };
      }

      // Explicit deny mode ⇒ denied before dispatch
      if (effectiveGrantMode === "deny") {
        const invocation = await store.insertInvocation({
          companyId,
          actorType,
          actorId,
          agentId,
          connectorId: req.connectorId,
          actionId: req.actionId,
          grantMode: "deny",
          outcome: "denied",
          reason: "mode_denied",
          pendingApprovalId: null,
          payloadSummary,
          correlationId: null,
        });
        return { decision: "denied", journalEntry: toJournalDto(invocation) };
      }

      // 3. Confirmation required check:
      // If either the grant mode is confirm, or the action descriptor itself demands confirm,
      // the call goes into pending-approval state and NEVER reaches the dispatcher.
      const requiresConfirmation = effectiveGrantMode === "confirm" || actionMode === "confirm";
      if (requiresConfirmation) {
        // Write the pending_confirmation journal row first
        const invocation = await store.insertInvocation({
          companyId,
          actorType,
          actorId,
          agentId,
          connectorId: req.connectorId,
          actionId: req.actionId,
          grantMode: effectiveGrantMode,
          outcome: "pending_confirmation",
          reason: "requires_confirmation",
          pendingApprovalId: null,
          payloadSummary,
          correlationId: null,
        });

        // Store the approval-pending state with the exact invocation linkage
        const approval = await store.insertPendingApproval({
          companyId,
          invocationId: invocation.id,
          agentId,
          connectorId: req.connectorId,
          actionId: req.actionId,
          status: "pending",
          request: req as unknown as Record<string, unknown>,
          requestedBy: `${actorType}:${actorId}`,
          resolvedBy: null,
          resolvedAt: null,
          payloadSummary,
        });

        // Retain pending approval id in the journal dto returned
        const journalDto = toJournalDto({ ...invocation, pendingApprovalId: approval.id });
        return { decision: "pending", journalEntry: journalDto };
      }

      // 4. Read vs Write dispatch permission check:
      const allowed = connectorModeAllowsDispatch(effectiveGrantMode, actionMode);
      if (!allowed) {
        // Read-only grant on a write action
        const reason = effectiveGrantMode === "read" ? "mode_denied_read_only" : "mode_denied";
        const invocation = await store.insertInvocation({
          companyId,
          actorType,
          actorId,
          agentId,
          connectorId: req.connectorId,
          actionId: req.actionId,
          grantMode: effectiveGrantMode,
          outcome: "denied",
          reason,
          pendingApprovalId: null,
          payloadSummary,
          correlationId: null,
        });
        return { decision: "denied", journalEntry: toJournalDto(invocation) };
      }

      // 5. Authorized: dispatch to external connector
      try {
        const dispatch = await dispatcher(req);
        const invocation = await store.insertInvocation({
          companyId,
          actorType,
          actorId,
          agentId,
          connectorId: req.connectorId,
          actionId: req.actionId,
          grantMode: effectiveGrantMode,
          outcome: dispatch.ok ? "success" : "error",
          reason: dispatch.ok ? "dispatched_allowed" : "dispatcher_failed",
          pendingApprovalId: null,
          payloadSummary,
          correlationId: null,
        });
        return {
          decision: "allowed",
          journalEntry: toJournalDto(invocation),
          dispatch,
        };
      } catch (err) {
        const invocation = await store.insertInvocation({
          companyId,
          actorType,
          actorId,
          agentId,
          connectorId: req.connectorId,
          actionId: req.actionId,
          grantMode: effectiveGrantMode,
          outcome: "error",
          reason: "dispatcher_exception",
          pendingApprovalId: null,
          payloadSummary,
          correlationId: null,
        });
        return {
          decision: "allowed",
          journalEntry: toJournalDto(invocation),
          dispatch: { ok: false, result: { error: err instanceof Error ? err.message : String(err) } },
        };
      }
    },

    /**
     * Resolve a pending approval.
     * When rejected: sets status=rejected, appends journal entry `denied_rejected_approval`.
     * When approved: sets status=approved, executes external dispatch, appends journal entry `approved_dispatch`.
     */
    async resolvePendingApproval(
      companyId: string,
      approvalId: string,
      decision: "approved" | "rejected",
      resolvedBy: string,
      dispatcher: ConnectorDispatcher,
    ): Promise<{
      resolved: boolean;
      decision: "approved" | "rejected";
      approval: ConnectorPendingApproval;
      dispatch?: ConnectorInvocationDispatchResult;
      journalEntry: ConnectorInvocationJournalEntry;
    }> {
      function approvalAlreadyResolvedConflict(status: string) {
        const err = conflict(`Approval is already resolved (${status})`, {
          code: "approval_already_resolved",
          status,
        });
        Object.assign(err, { code: "approval_already_resolved" });
        return err;
      }

      const approval = await store.findPendingApproval(companyId, approvalId);
      if (!approval) throw notFound("Pending approval not found");
      if (approval.status !== "pending") {
        throw approvalAlreadyResolvedConflict(approval.status);
      }

      const now = new Date();
      const updated = await store.resolvePendingApproval(companyId, approvalId, decision, resolvedBy, now);
      if (!updated) {
        const latest = await store.findPendingApproval(companyId, approvalId);
        if (!latest) throw notFound("Pending approval not found");
        throw approvalAlreadyResolvedConflict(latest.status);
      }

      if (decision === "rejected") {
        const journalRow = await store.insertInvocation({
          companyId,
          actorType: "user",
          actorId: resolvedBy,
          agentId: approval.agentId,
          connectorId: approval.connectorId,
          actionId: approval.actionId,
          grantMode: "confirm",
          outcome: "denied_rejected_approval",
          reason: "rejected_by_human",
          pendingApprovalId: approvalId,
          payloadSummary: approval.payloadSummary,
          correlationId: null,
        });
        return {
          resolved: true,
          decision: "rejected",
          approval: toApprovalDto(updated),
          journalEntry: toJournalDto(journalRow),
        };
      }

      // Approved: dispatch to external connector
      const dispatch = await dispatcher(approval.request as unknown as InvokeConnectorActionRequest);
      const journalRow = await store.insertInvocation({
        companyId,
        actorType: "user",
        actorId: resolvedBy,
        agentId: approval.agentId,
        connectorId: approval.connectorId,
        actionId: approval.actionId,
        grantMode: "confirm",
        outcome: dispatch.ok ? "approved_dispatch" : "error",
        reason: dispatch.ok ? "approved_by_human" : "dispatcher_failed_on_approval",
        pendingApprovalId: approvalId,
        payloadSummary: approval.payloadSummary,
        correlationId: null,
      });

      return {
        resolved: true,
        decision: "approved",
        approval: toApprovalDto(updated),
        dispatch,
        journalEntry: toJournalDto(journalRow),
      };
    },

    /** Query append-only invocation audit journal. */
    async queryJournal(
      companyId: string,
      query: ConnectorInvocationJournalQuery = {},
    ): Promise<ConnectorInvocationJournalPage> {
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      const { rows, total } = await store.queryJournal(companyId, query);
      return {
        entries: rows.map(toJournalDto),
        total,
        limit,
        offset,
      };
    },

    /** List pending approvals. */
    async listPendingApprovals(
      companyId: string,
      status?: ConnectorPendingApprovalStatus,
    ): Promise<ConnectorPendingApproval[]> {
      const rows = await store.listPendingApprovals(companyId, status);
      return rows.map(toApprovalDto);
    },
  };
}
