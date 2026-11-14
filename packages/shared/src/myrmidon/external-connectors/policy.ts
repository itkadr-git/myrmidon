// myrmidon(OPE-13026): per-agent × connector × action policy and invocation
// audit contracts (OPE-12992 ч.3/ч.4 — the persistence and journal-query layer).
//
// This module shares the catalog contract from `./catalog.js` (OPE-13019) and
// adds:
//   - policy grant records (agent × connector × action, mode read/write/confirm
//     or an explicit deny);
//   - the connector invocation journal entry (append-only audit record with
//     actor, connector, action, timestamp, outcome);
//   - the pending-approval record for confirmation-required calls (a call in
//     this state never reaches the connector until a human approves it);
//   - request/response schemas for the policy and journal query API
//     (`/api/myrmidon/external-connectors/*`).
//
// Like the catalog module this file is contracts only: no execution, no
// provider logic, no persistence and no HTTP routes.

import { z } from "zod";
import {
  connectorActionIdSchema,
  connectorIdSchema,
  type ConnectorActionMode,
} from "./catalog.js";

// ---------------------------------------------------------------------------
// Policy grant modes
// ---------------------------------------------------------------------------

/**
 * Access mode a policy grant gives the agent for the action:
 *   - `read`:    read-mode actions dispatch, write/confirm actions are denied;
 *   - `write`:   read and write actions dispatch, confirm-mode actions still
 *                wait for a human approval;
 *   - `confirm`: every action on the grant waits for a human approval first;
 *   - `deny`:    explicit denial — every call is denied before dispatch.
 */
export const CONNECTOR_POLICY_GRANT_MODES = ["read", "write", "confirm", "deny"] as const;
export type ConnectorPolicyGrantMode = (typeof CONNECTOR_POLICY_GRANT_MODES)[number];

export const connectorPolicyGrantModeSchema = z.enum(CONNECTOR_POLICY_GRANT_MODES);

/**
 * Wildcard for the action scope of a policy grant: the grant covers every
 * action of the connector. A grant that names a concrete action id wins over
 * the connector-wide grant.
 */
export const CONNECTOR_POLICY_ACTION_WILDCARD = "*";

export const connectorPolicyActionScopeSchema = z.union([
  z.literal(CONNECTOR_POLICY_ACTION_WILDCARD),
  connectorActionIdSchema,
]);

// ---------------------------------------------------------------------------
// Policy grant record
// ---------------------------------------------------------------------------

export const connectorPolicyGrantSchema = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    /** The agent the grant applies to. */
    agentId: z.string().uuid(),
    /** The connector (system) the grant applies to. */
    connectorId: connectorIdSchema,
    /** Concrete action id or `*` for connector-wide grants. */
    actionId: connectorPolicyActionScopeSchema,
    mode: connectorPolicyGrantModeSchema,
    /** Who created/updated the grant: `agent:<uuid>` or `user:<id>`. */
    createdBy: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ConnectorPolicyGrant = z.infer<typeof connectorPolicyGrantSchema>;

export const putConnectorPolicyGrantsRequestSchema = z
  .object({
    /** Full replacement list for one (agentId, connectorId) pair. */
    agentId: z.string().uuid(),
    connectorId: connectorIdSchema,
    /** At least one grant: an empty list would silently leave deny-by-default. */
    grants: z
      .array(
        z
          .object({
            actionId: connectorPolicyActionScopeSchema,
            mode: connectorPolicyGrantModeSchema,
          })
          .strict(),
      )
      .min(1, "grants must list at least one action scope"),
  })
  .strict();

export type PutConnectorPolicyGrantsRequest = z.infer<typeof putConnectorPolicyGrantsRequestSchema>;

export const listConnectorPolicyGrantsQuerySchema = z
  .object({
    agentId: z.string().uuid().optional(),
    connectorId: connectorIdSchema.optional(),
  })
  .strict();

export type ListConnectorPolicyGrantsQuery = z.infer<typeof listConnectorPolicyGrantsQuerySchema>;

// ---------------------------------------------------------------------------
// Invocation outcomes
// ---------------------------------------------------------------------------

/**
 * Terminal outcome recorded in the append-only journal for every attempted
 * call. `pending_confirmation` is the initial outcome of a confirmation-gated
 * call; the journal row itself stays immutable — the resolution of the
 * approval is a second row (`approved_dispatch`, `denied_rejected_approval`)
 * written by the approve/reject handlers.
 */
export const CONNECTOR_INVOCATION_OUTCOMES = [
  "success",
  "denied",
  "pending_confirmation",
  "approved_dispatch",
  "denied_rejected_approval",
  "denied_conflict",
  "error",
] as const;
export type ConnectorInvocationOutcome = (typeof CONNECTOR_INVOCATION_OUTCOMES)[number];

export const connectorInvocationOutcomeSchema = z.enum(CONNECTOR_INVOCATION_OUTCOMES);

// ---------------------------------------------------------------------------
// Invocation request / result contracts (server-side enforcement API)
// ---------------------------------------------------------------------------

/** The actor attempting the call: an agent (the normal path) or a board user. */
export const connectorInvocationActorSchema = z
  .object({
    type: z.enum(["agent", "user"]),
    /** Agent id when type=agent; board user id when type=user. */
    id: z.string().min(1).max(200),
  })
  .strict();

export type ConnectorInvocationActor = z.infer<typeof connectorInvocationActorSchema>;

export const invokeConnectorActionRequestSchema = z
  .object({
    actor: connectorInvocationActorSchema,
    connectorId: connectorIdSchema,
    actionId: connectorActionIdSchema,
    /** Arbitrary JSON payload forwarded to the connector dispatcher on allow. */
    payload: z.unknown(),
  })
  .strict();

export type InvokeConnectorActionRequest = z.infer<typeof invokeConnectorActionRequestSchema>;

export const connectorInvocationDispatchResultSchema = z
  .object({
    ok: z.boolean(),
    /** Dispatcher-provided result payload (sanitized by the dispatcher). */
    result: z.unknown(),
  })
  .strict();

export type ConnectorInvocationDispatchResult = z.infer<
  typeof connectorInvocationDispatchResultSchema
>;

export type ConnectorInvocationEnforcement =
  | { decision: "allowed"; journalEntry: ConnectorInvocationJournalEntry; dispatch: ConnectorInvocationDispatchResult }
  | { decision: "pending"; journalEntry: ConnectorInvocationJournalEntry }
  | { decision: "denied"; journalEntry: ConnectorInvocationJournalEntry };

// ---------------------------------------------------------------------------
// Pending approval record
// ---------------------------------------------------------------------------

export const CONNECTOR_PENDING_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ConnectorPendingApprovalStatus = (typeof CONNECTOR_PENDING_APPROVAL_STATUSES)[number];

export const connectorPendingApprovalStatusSchema = z.enum(CONNECTOR_PENDING_APPROVAL_STATUSES);

export const connectorPendingApprovalSchema = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    /** Journal entry the approval belongs to (the pending_confirmation row). */
    invocationId: z.string().uuid(),
    agentId: z.string().uuid(),
    connectorId: connectorIdSchema,
    actionId: connectorActionIdSchema,
    status: connectorPendingApprovalStatusSchema,
    requestedBy: z.string().min(1).max(200),
    /** Who approved/rejected and when; null while pending. */
    resolvedBy: z.string().min(1).max(200).nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ConnectorPendingApproval = z.infer<typeof connectorPendingApprovalSchema>;

export const resolveConnectorPendingApprovalRequestSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    /** Board user (or acting admin agent) that resolved the approval. */
    resolvedBy: z.string().min(1).max(200),
  })
  .strict();

export type ResolveConnectorPendingApprovalRequest = z.infer<
  typeof resolveConnectorPendingApprovalRequestSchema
>;

// ---------------------------------------------------------------------------
// Invocation journal entry (append-only audit record)
// ---------------------------------------------------------------------------

export const connectorInvocationJournalEntrySchema = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    /** Who attempted the call. */
    actorType: z.enum(["agent", "user"]),
    actorId: z.string().min(1).max(200),
    /** The system (connector) and action of the call. */
    connectorId: connectorIdSchema,
    actionId: connectorActionIdSchema,
    /** Policy grant mode that drove the decision, when a grant matched. */
    grantMode: connectorPolicyGrantModeSchema.nullable(),
    outcome: connectorInvocationOutcomeSchema,
    /** Machine-readable denial/pend reason (e.g. no_grant, mode_denied). */
    reason: z.string().min(1).max(120),
    /** Stable id of the pending approval while outcome=pending_confirmation. */
    pendingApprovalId: z.string().uuid().nullable(),
    /** Redacted summary of the call payload, for the rights screen journal. */
    payloadSummary: z.string().max(2000).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ConnectorInvocationJournalEntry = z.infer<typeof connectorInvocationJournalEntrySchema>;

// ---------------------------------------------------------------------------
// Journal query contract
// ---------------------------------------------------------------------------

export const connectorInvocationJournalQuerySchema = z
  .object({
    agentId: z.string().uuid().optional(),
    connectorId: connectorIdSchema.optional(),
    actionId: connectorActionIdSchema.optional(),
    outcome: connectorInvocationOutcomeSchema.optional(),
    /** Inclusive lower bound (ISO datetime). */
    from: z.string().datetime().optional(),
    /** Inclusive upper bound (ISO datetime). */
    to: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export type ConnectorInvocationJournalQuery = z.infer<typeof connectorInvocationJournalQuerySchema>;

export const connectorInvocationJournalPageSchema = z
  .object({
    entries: z.array(connectorInvocationJournalEntrySchema),
    total: z.number().int().min(0),
    limit: z.number().int().min(1).max(200),
    offset: z.number().int().min(0),
  })
  .strict();

export type ConnectorInvocationJournalPage = z.infer<typeof connectorInvocationJournalPageSchema>;

// ---------------------------------------------------------------------------
// Helpers shared by the enforcement layer and the rights screen
// ---------------------------------------------------------------------------

/**
 * Effective mode resolution for (agent, connector, action):
 * a grant naming the exact action wins over the `*` connector-wide grant;
 * an explicit `deny` wins over any other mode at the same scope; no grant at
 * all fails closed (deny).
 */
export function resolveConnectorPolicyMode(
  grants: Array<Pick<ConnectorPolicyGrant, "actionId" | "mode">>,
  actionId: string,
): ConnectorPolicyGrantMode | null {
  const actionGrant = grants.find((grant) => grant.actionId === actionId);
  const wildcardGrant = grants.find((grant) => grant.actionId === CONNECTOR_POLICY_ACTION_WILDCARD);
  const candidates = [actionGrant?.mode, wildcardGrant?.mode].filter(
    (mode): mode is ConnectorPolicyGrantMode => mode != null,
  );
  if (candidates.length === 0) return null;
  if (candidates.includes("deny")) return "deny";
  if (candidates.includes("confirm")) return "confirm";
  if (candidates.includes("write")) return "write";
  return "read";
}

/**
 * Whether a call for an action with catalog mode `actionMode` may dispatch
 * immediately under grant mode `grantMode`. `write` grant mode does NOT
 * promote confirm-mode actions to auto-dispatch: those still wait for a human.
 */
export function connectorModeAllowsDispatch(
  grantMode: ConnectorPolicyGrantMode,
  actionMode: ConnectorActionMode,
): boolean {
  if (grantMode === "deny") return false;
  if (actionMode === "confirm") return false; // always goes through approval
  if (grantMode === "confirm") return false;
  if (grantMode === "write") return true; // write implies read
  return actionMode === "read"; // read-only grant
}

/** True when the journal outcome means the call never reached the connector. */
export function connectorInvocationBlocked(outcome: ConnectorInvocationOutcome): boolean {
  return (
    outcome === "denied" ||
    outcome === "pending_confirmation" ||
    outcome === "denied_rejected_approval" ||
    outcome === "denied_conflict"
  );
}
