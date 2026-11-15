import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { approvals, budgetPolicies, companySecrets, companySkills, issues, knowledgeItems, projects, toolConnections } from "@myrmidon/db";
import {
  ADM_ACCESS_REQUEST_TYPE,
  redactedAdmRequestProjection,
  admAccessActions,
  type AdmAccessAction,
  type AdmRequestStatus,
  type AdmResourceType,
  type CreateAdmAccessRequestInput,
  type DecideAdmAccessRequestInput,
  type ExecuteAdmCapabilityInput,
  type RevokeAdmAccessRequestInput,
  type RedactedAdmRequest,
} from "@myrmidon/shared";
import {
  admScopeHash,
  createAdmCapabilityToken,
  verifyAdmCapabilityToken,
  type AdmCapabilityClaims,
} from "@myrmidon/shared/adm-access-request-server";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";

/** Parses `type:key` resource refs (e.g. `skill:atlas-report` → `atlas-report`). */
function admResourceKeyFromRef(resourceRef: string): string {
  const colon = resourceRef.indexOf(":");
  return colon >= 0 ? resourceRef.slice(colon + 1).trim() : resourceRef.trim();
}

export interface AdmResourceProjection {
  key: string | null;
  name: string | null;
  status: string | null;
  createdAt: string | null;
}

export interface AdmScopedResource {
  projection: AdmResourceProjection;
}

/**
 * Resolves one resource row inside the target (ADM) company namespace only.
 * Every branch is keyed by `(companyId, key)`; the source company never
 * appears in a lookup. Projections carry name/status/timestamps — never raw
 * secret values, markdown bodies, credentials or issue content.
 */
async function admLookupScopedResource(
  db: Db,
  targetCompanyId: string,
  resourceType: string,
  key: string,
): Promise<AdmScopedResource | null> {
  switch (resourceType) {
    case "skill": {
      const row = await db
        .select({ key: companySkills.key, name: companySkills.name, status: companySkills.trustLevel, createdAt: companySkills.createdAt })
        .from(companySkills)
        .where(and(eq(companySkills.companyId, targetCompanyId), eq(companySkills.key, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row
        ? { projection: { key: row.key, name: row.name, status: row.status, createdAt: row.createdAt?.toISOString() ?? null } }
        : null;
    }
    case "secret": {
      const row = await db
        .select({ key: companySecrets.key, name: companySecrets.name, status: companySecrets.status, createdAt: companySecrets.createdAt })
        .from(companySecrets)
        .where(and(eq(companySecrets.companyId, targetCompanyId), eq(companySecrets.key, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row
        ? { projection: { key: row.key, name: row.name, status: row.status, createdAt: row.createdAt?.toISOString() ?? null } }
        : null;
    }
    case "connection":
    case "tool": {
      const row = await db
        .select({ key: toolConnections.name, name: toolConnections.name, status: toolConnections.status, createdAt: toolConnections.createdAt })
        .from(toolConnections)
        .where(and(eq(toolConnections.companyId, targetCompanyId), eq(toolConnections.name, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row
        ? { projection: { key: row.key, name: row.name, status: row.status, createdAt: row.createdAt?.toISOString() ?? null } }
        : null;
    }
    case "project": {
      const row = await db
        .select({ key: projects.id, name: projects.name, status: projects.status, createdAt: projects.createdAt })
        .from(projects)
        .where(and(eq(projects.companyId, targetCompanyId), eq(projects.name, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row
        ? { projection: { key, name: row.name, status: row.status, createdAt: row.createdAt?.toISOString() ?? null } }
        : null;
    }
    case "task": {
      const row = await db
        .select({ key: issues.id, name: issues.title, status: issues.status, createdAt: issues.createdAt })
        .from(issues)
        .where(and(eq(issues.companyId, targetCompanyId), eq(issues.id, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row
        ? { projection: { key: row.key, name: row.name, status: row.status, createdAt: row.createdAt?.toISOString() ?? null } }
        : null;
    }
    case "budget": {
      const row = await db
        .select({ key: budgetPolicies.scopeType, name: budgetPolicies.windowKind, status: budgetPolicies.metric, createdAt: budgetPolicies.createdAt })
        .from(budgetPolicies)
        .where(and(eq(budgetPolicies.companyId, targetCompanyId), eq(budgetPolicies.scopeType, key), eq(budgetPolicies.isActive, true)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row
        ? { projection: { key: row.key, name: row.name, status: row.status, createdAt: row.createdAt?.toISOString() ?? null } }
        : null;
    }
    case "memory": {
      const row = await db
        .select({ key: knowledgeItems.slug, name: knowledgeItems.title, status: knowledgeItems.status, createdAt: knowledgeItems.createdAt })
        .from(knowledgeItems)
        .where(and(eq(knowledgeItems.companyId, targetCompanyId), eq(knowledgeItems.slug, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row
        ? { projection: { key: row.key, name: row.name, status: row.status, createdAt: row.createdAt?.toISOString() ?? null } }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Aggregate-only read (budget health and counts). Returns company-scoped
 * counters and, for budgets, warn/hard-stop state — never per-agent raw cost
 * rows of another company.
 */
async function admAggregateScopedResource(
  db: Db,
  targetCompanyId: string,
  resourceType: string,
  key: string,
): Promise<Record<string, unknown>> {
  switch (resourceType) {
    case "budget": {
      const rows = await db
        .select({
          scopeType: budgetPolicies.scopeType,
          scopeId: budgetPolicies.scopeId,
          metric: budgetPolicies.metric,
          windowKind: budgetPolicies.windowKind,
          amount: budgetPolicies.amount,
          hardStopEnabled: budgetPolicies.hardStopEnabled,
          isActive: budgetPolicies.isActive,
        })
        .from(budgetPolicies)
        .where(and(eq(budgetPolicies.companyId, targetCompanyId), eq(budgetPolicies.isActive, true)))
        .limit(50);
      const scoped = rows.filter((row) => key.length === 0 || row.scopeType === key);
      return {
        count: scoped.length,
        scopes: [...new Set(scoped.map((row) => row.scopeType))],
        hardStopEnabled: scoped.every((row) => row.hardStopEnabled),
      };
    }
    case "task": {
      const target = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(and(eq(issues.companyId, targetCompanyId), eq(issues.id, key)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return { count: target ? 1 : 0, exists: target !== null };
    }
    default: {
      const found = await admLookupScopedResource(db, targetCompanyId, resourceType, key);
      return { count: found ? 1 : 0 };
    }
  }
}


export const ADM_APPROVAL_TYPE = ADM_ACCESS_REQUEST_TYPE;

export interface AdmActorContext {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
  isInstanceAdmin?: boolean;
}

/**
 * Controlled execution seam (ADR-0052 step 5): the capability executes the
 * operation inside the ADM gateway, never inside this service. The executor
 * receives the approved envelope and MUST perform the real bounded action —
 * returning `executed: false` with a reason code is the honest outcome for a
 * tool that is unavailable or refuses the operation. Without a wired
 * executor the gateway denies `invoke_tool` instead of pretending success.
 */
export interface AdmCapabilityExecutor {
  execute(input: {
    requestId: string;
    sourceCompanyId: string;
    targetCompanyId: string;
    resourceType: string;
    resourceRef: string;
    resourceKey: string;
    action: AdmAccessAction;
    scope: Record<string, unknown>;
    actor: AdmActorContext;
  }): Promise<{ executed: boolean; result: Record<string, unknown> }>;
}

export interface AdmRequestStoredPayload {
  sourceCompanyId: string;
  targetCompanyId: string;
  requesterType: "agent" | "user";
  requesterId: string;
  resourceType: AdmResourceType;
  resourceRef: string;
  action: AdmAccessAction;
  justification: string;
  requestedScope: Record<string, unknown>;
  scopeHash: string;
  ttlSeconds: number;
  idempotencyKey: string;
  correlationRunId: string | null;
  issuedCapabilityHash?: string | null;
  expiresAt?: string | null;
  metadataProjection?: Record<string, unknown> | null;
}

export function admAccessRequestService(
  db: Db,
  executor?: AdmCapabilityExecutor,
) {
  /**
   * Scope enforcement (ADR-0052 step 6): the approved capability is
   * constrained to the requested scope. The resource key implied by the
   * capability claims must equal the scope's `resourceKey` when one was
   * requested; the executed operation kind must match the scope's
   * `operationKind` when declared; and the live scope hash must equal the
   * hash signed into the capability. A mismatch is a hard denial before any
   * effect, audited as `scope_violation`.
   */
  function assertExecutionWithinScope(
    claims: AdmCapabilityClaims,
    payload: AdmRequestStoredPayload,
  ): Record<string, unknown> {
    const scope = payload.requestedScope ?? {};
    if (admScopeHash(scope) !== claims.scopeHash) {
      throw forbidden("Capability scope hash does not match the approved request scope");
    }
    const resourceKey = admResourceKeyFromRef(claims.resourceRef);
    const scopeResourceKey = typeof scope.resourceKey === "string" ? scope.resourceKey.trim() : null;
    if (scopeResourceKey !== null && scopeResourceKey.length > 0 && scopeResourceKey !== resourceKey) {
      throw forbidden("Capability resource key is outside the approved scope");
    }
    const scopeOperationKind = typeof scope.operationKind === "string" ? scope.operationKind.trim().toLowerCase() : null;
    if (scopeOperationKind !== null && scopeOperationKind.length > 0) {
      const operationKindForAction = claims.action === "invoke_tool" ? "invoke" : claims.action;
      if (scopeOperationKind !== operationKindForAction) {
        throw forbidden("Capability operation kind is outside the approved scope");
      }
    }
    return scope;
  }
  function mapApprovalToRecord(
    row: typeof approvals.$inferSelect,
  ): RedactedAdmRequest & {
    id: string;
    targetCompanyId: string;
    requesterType: string;
    requesterId: string;
    decisionNote: string | null;
    decidedByUserId: string | null;
  } {
    const payload = (row.payload ?? {}) as unknown as AdmRequestStoredPayload;
    const createdAt = row.createdAt ?? new Date();
    const ttlSeconds = typeof payload.ttlSeconds === "number" ? payload.ttlSeconds : 3600;
    const computedExpiry = payload.expiresAt
      ? new Date(payload.expiresAt)
      : new Date(createdAt.getTime() + ttlSeconds * 1000);

    let effectiveStatus: AdmRequestStatus = (row.status as AdmRequestStatus) ?? "pending";
    if (effectiveStatus === "pending" && Date.now() > computedExpiry.getTime()) {
      effectiveStatus = "expired";
    }

    const projected = redactedAdmRequestProjection({
      requestId: row.id,
      sourceCompanyId: payload.sourceCompanyId ?? "",
      targetCompanyId: payload.targetCompanyId ?? row.companyId,
      resourceType: payload.resourceType ?? "skill",
      resourceRef: payload.resourceRef ?? "",
      action: payload.action ?? "read_metadata",
      status: effectiveStatus,
      scopeHash: payload.scopeHash ?? "",
      justification: payload.justification ?? "",
      createdAt,
      decidedAt: row.decidedAt ?? null,
      expiresAt: computedExpiry,
    });

    return {
      ...projected,
      id: row.id,
      targetCompanyId: payload.targetCompanyId ?? row.companyId,
      requesterType: payload.requesterType ?? "agent",
      requesterId: payload.requesterId ?? (row.requestedByAgentId ?? row.requestedByUserId ?? ""),
      decisionNote: row.decisionNote ?? null,
      decidedByUserId: row.decidedByUserId ?? null,
      expiresAt: computedExpiry?.toISOString() ?? null,
    };
  }

  return {
    async create(
      sourceCompanyId: string,
      input: CreateAdmAccessRequestInput,
      actor: AdmActorContext,
    ): Promise<{ request: RedactedAdmRequest; isExisting: boolean }> {
      if (actor.companyId !== sourceCompanyId) {
        throw forbidden("Actor cannot create an access request on behalf of another company");
      }
      if (input.targetCompanyId === sourceCompanyId) {
        throw badRequest("Cross-company request target cannot match source company");
      }

      // Idempotency check: same source company and same idempotencyKey returns existing request.
      const existing = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.type, ADM_APPROVAL_TYPE),
            sql`(${approvals.payload}->>'idempotencyKey') = ${input.idempotencyKey}`,
            sql`(${approvals.payload}->>'sourceCompanyId') = ${sourceCompanyId}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return {
          request: mapApprovalToRecord(existing),
          isExisting: true,
        };
      }

      const scopeHash = admScopeHash(input.requestedScope);
      const requesterType: "agent" | "user" = actor.agentId ? "agent" : "user";
      const requesterId = actor.agentId ?? actor.userId ?? actor.actorId;

      const storedPayload: AdmRequestStoredPayload = {
        sourceCompanyId,
        targetCompanyId: input.targetCompanyId,
        requesterType,
        requesterId,
        resourceType: input.resourceType,
        resourceRef: input.resourceRef,
        action: input.action,
        justification: input.justification,
        requestedScope: input.requestedScope,
        scopeHash,
        ttlSeconds: input.ttlSeconds ?? 3600,
        idempotencyKey: input.idempotencyKey,
        correlationRunId: input.correlationRunId ?? actor.runId ?? null,
      };

      const [inserted] = await db
        .insert(approvals)
        .values({
          companyId: input.targetCompanyId,
          type: ADM_APPROVAL_TYPE,
          requestedByAgentId: actor.agentId ?? null,
          requestedByUserId: actor.userId ?? null,
          status: "pending",
          payload: storedPayload as unknown as Record<string, unknown>,
        })
        .returning();

      if (!inserted) {
        throw badRequest("Failed to insert access request");
      }

      // Immutable audit log on the source company side.
      await logActivity(db, {
        companyId: sourceCompanyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
        action: "adm_access_request.created",
        entityType: "adm_access_request",
        entityId: inserted.id,
        details: {
          requestId: inserted.id,
          targetCompanyId: input.targetCompanyId,
          resourceType: input.resourceType,
          resourceRef: input.resourceRef,
          action: input.action,
          ttlSeconds: input.ttlSeconds ?? 3600,
          idempotencyKey: input.idempotencyKey,
          correlationRunId: storedPayload.correlationRunId,
        },
      });

      // Immutable audit log on the target (ADM) company side.
      await logActivity(db, {
        companyId: input.targetCompanyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
        action: "adm_access_request.received",
        entityType: "adm_access_request",
        entityId: inserted.id,
        details: {
          requestId: inserted.id,
          sourceCompanyId,
          resourceType: input.resourceType,
          resourceRef: input.resourceRef,
          action: input.action,
          scopeHash,
          ttlSeconds: input.ttlSeconds,
        },
      });

      return {
        request: mapApprovalToRecord(inserted),
        isExisting: false,
      };
    },

    async getById(
      id: string,
      callingCompanyId: string,
    ): Promise<
      | (RedactedAdmRequest & {
          id: string;
          targetCompanyId: string;
          decisionNote: string | null;
        })
      | null
    > {
      const row = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, id), eq(approvals.type, ADM_APPROVAL_TYPE)))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!row) return null;

      const payload = (row.payload ?? {}) as unknown as AdmRequestStoredPayload;
      // Deny-by-default existence oracle guard: if caller is not source nor target company, return null.
      if (payload.sourceCompanyId !== callingCompanyId && payload.targetCompanyId !== callingCompanyId) {
        return null;
      }

      return mapApprovalToRecord(row);
    },

    async list(callingCompanyId: string): Promise<RedactedAdmRequest[]> {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.type, ADM_APPROVAL_TYPE),
            sql`(${approvals.payload}->>'sourceCompanyId' = ${callingCompanyId} OR ${approvals.payload}->>'targetCompanyId' = ${callingCompanyId} OR ${approvals.companyId} = ${callingCompanyId})`,
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(100);

      return rows.map((r) => mapApprovalToRecord(r));
    },

    async decide(
      id: string,
      callingCompanyId: string,
      input: DecideAdmAccessRequestInput,
      actor: AdmActorContext,
    ): Promise<{
      request: RedactedAdmRequest;
      capabilityToken?: string;
    }> {
      const row = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, id), eq(approvals.type, ADM_APPROVAL_TYPE)))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!row) {
        throw notFound("Access request not found");
      }

      const payload = (row.payload ?? {}) as unknown as AdmRequestStoredPayload;
      // Only the target (ADM) company operator or instance admin can decide.
      if (payload.targetCompanyId !== callingCompanyId && !actor.isInstanceAdmin) {
        throw forbidden("Only the target ADM company can decide access requests");
      }

      if (row.status !== "pending") {
        throw conflict(`Cannot decide request with status '${row.status}'`);
      }

      const createdAt = row.createdAt ?? new Date();
      const effectiveTtl = input.ttlSeconds ?? payload.ttlSeconds ?? 3600;
      const expiresAt = new Date(Date.now() + effectiveTtl * 1000);

      let issuedToken: string | undefined;
      let issuedCapabilityHash: string | null = null;

      if (input.decision === "approved") {
        const capabilityResult = createAdmCapabilityToken({
          requestId: row.id,
          sourceCompanyId: payload.sourceCompanyId,
          targetCompanyId: payload.targetCompanyId,
          requesterType: payload.requesterType,
          requesterId: payload.requesterId,
          resourceType: payload.resourceType,
          resourceRef: payload.resourceRef,
          action: payload.action,
          scopeHash: payload.scopeHash,
          ttlSeconds: effectiveTtl,
        });

        if (!capabilityResult) {
          throw badRequest("Unable to issue capability token: signing secret unconfigured");
        }
        issuedToken = capabilityResult.token;
        issuedCapabilityHash = capabilityResult.capabilityHash;
      }

      const updatedPayload: AdmRequestStoredPayload = {
        ...payload,
        ttlSeconds: effectiveTtl,
        issuedCapabilityHash,
        expiresAt: expiresAt.toISOString(),
      };

      const [updated] = await db
        .update(approvals)
        .set({
          status: input.decision,
          decisionNote: input.reason ?? null,
          decidedByUserId: actor.userId ?? actor.actorId,
          decidedAt: new Date(),
          updatedAt: new Date(),
          payload: updatedPayload as unknown as Record<string, unknown>,
        })
        .where(eq(approvals.id, row.id))
        .returning();

      if (!updated) {
        throw badRequest("Failed to update access request");
      }

      // Log audit events on both companies.
      await logActivity(db, {
        companyId: payload.targetCompanyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "adm_access_request.decided",
        entityType: "adm_access_request",
        entityId: row.id,
        details: {
          requestId: row.id,
          decision: input.decision,
          reason: input.reason ?? null,
          capabilityHash: issuedCapabilityHash,
          ttlSeconds: effectiveTtl,
        },
      });

      await logActivity(db, {
        companyId: payload.sourceCompanyId,
        actorType: "system",
        actorId: "adm_gateway",
        action: "adm_access_request.decided",
        entityType: "adm_access_request",
        entityId: row.id,
        details: {
          requestId: row.id,
          decision: input.decision,
          reason: input.reason ?? null,
          capabilityHash: issuedCapabilityHash,
          expiresAt: expiresAt.toISOString(),
        },
      });

      return {
        request: mapApprovalToRecord(updated),
        capabilityToken: issuedToken,
      };
    },

    async revoke(
      id: string,
      callingCompanyId: string,
      input: RevokeAdmAccessRequestInput,
      actor: AdmActorContext,
    ): Promise<RedactedAdmRequest> {
      const row = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, id), eq(approvals.type, ADM_APPROVAL_TYPE)))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!row) {
        throw notFound("Access request not found");
      }

      const payload = (row.payload ?? {}) as unknown as AdmRequestStoredPayload;
      if (
        payload.sourceCompanyId !== callingCompanyId &&
        payload.targetCompanyId !== callingCompanyId &&
        !actor.isInstanceAdmin
      ) {
        throw notFound("Access request not found");
      }

      if (row.status === "revoked") {
        return mapApprovalToRecord(row);
      }

      const [updated] = await db
        .update(approvals)
        .set({
          status: "revoked",
          decisionNote: input.reason ?? "Revoked",
          updatedAt: new Date(),
        })
        .where(eq(approvals.id, row.id))
        .returning();

      await logActivity(db, {
        companyId: payload.sourceCompanyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "adm_access_request.revoked",
        entityType: "adm_access_request",
        entityId: row.id,
        details: {
          requestId: row.id,
          reason: input.reason ?? null,
        },
      });

      return mapApprovalToRecord(updated!);
    },

    async executeCapability(
      input: ExecuteAdmCapabilityInput,
      actor: AdmActorContext,
    ): Promise<{
      executed: boolean;
      requestId: string;
      resourceType: AdmResourceType;
      resourceRef: string;
      action: AdmAccessAction;
      result: Record<string, unknown>;
    }> {
      // 1. Verify capability token signature and format.
      const claims: AdmCapabilityClaims | null = verifyAdmCapabilityToken(input.capabilityToken);
      if (!claims) {
        throw forbidden("Invalid or expired ADM capability token");
      }

      // 2. Audience binding: token can only be executed by callers from the sourceCompanyId.
      if (claims.sourceCompanyId !== actor.companyId && !actor.isInstanceAdmin) {
        throw forbidden("Capability token audience mismatch: token bound to different company");
      }

      // 3. Status verification against the database: must still be 'approved' and not revoked/expired.
      const row = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, claims.requestId), eq(approvals.type, ADM_APPROVAL_TYPE)))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!row) {
        throw forbidden("ADM capability request record not found");
      }

      if (row.status !== "approved") {
        throw forbidden(`ADM capability cannot be executed: status is '${row.status}'`);
      }

      const payload = (row.payload ?? {}) as unknown as AdmRequestStoredPayload;
      if (payload.expiresAt && Date.now() > new Date(payload.expiresAt).getTime()) {
        throw forbidden("ADM capability has expired");
      }
      const scope = assertExecutionWithinScope(claims, payload);
      if (!(admAccessActions as readonly string[]).includes(claims.action)) {
        throw forbidden("ADM capability action is not supported");
      }
      if (claims.resourceType === "tool" && claims.action !== "invoke_tool") {
        throw forbidden("Tool capabilities may only invoke an approved tool");
      }
      if (claims.action === "invoke_tool" && !executor) {
        throw forbidden("Controlled tool executor is not configured");
      }
      if (claims.action === "grant_capability" && claims.resourceType === "secret") {
        throw forbidden("Secret capabilities cannot be granted through the ADM gateway");
      }

      // 4. Scoped execution against the target company's data: every lookup is
      // double-keyed by (targetCompanyId, resourceRef-derived key) so the
      // capability can never surface another company's row. Only metadata
      // projections and aggregates leave the ADM boundary — never raw secret
      // values, markdown bodies, connection credentials or issue content.
      let executionResult: Record<string, unknown>;
      let executed = true;
      switch (claims.action) {
        case "read_metadata": {
          const resourceKey = admResourceKeyFromRef(claims.resourceRef);
          const found = await admLookupScopedResource(db, claims.targetCompanyId, claims.resourceType, resourceKey);
          executionResult = {
            kind: "metadata_projection",
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            scopeHash: claims.scopeHash,
            // Existence oracle stays closed: unknown and foreign ids answer identically.
            available: found !== null,
            projection: found?.projection ?? null,
            version: "1.0",
          };
          break;
        }
        case "query_aggregate": {
          const resourceKey = admResourceKeyFromRef(claims.resourceRef);
          const aggregate = await admAggregateScopedResource(db, claims.targetCompanyId, claims.resourceType, resourceKey);
          executionResult = {
            kind: "aggregate_metrics",
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            scopeHash: claims.scopeHash,
            ...aggregate,
            sampleAt: new Date().toISOString(),
          };
          break;
        }
        case "invoke_tool": {
          const resourceKey = admResourceKeyFromRef(claims.resourceRef);
          const invocation = await executor!.execute({
            requestId: claims.requestId,
            sourceCompanyId: claims.sourceCompanyId,
            targetCompanyId: claims.targetCompanyId,
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            resourceKey,
            action: claims.action as AdmAccessAction,
            scope,
            actor,
          });
          executed = invocation.executed;
          executionResult = invocation.result;
          break;
        }
        case "bounds": {
          const resourceKey = admResourceKeyFromRef(claims.resourceRef);
          const found = await admLookupScopedResource(db, claims.targetCompanyId, claims.resourceType, resourceKey);
          executionResult = {
            kind: "resource_bounds",
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            available: found !== null,
            bounds: found ? { status: found.projection.status, operationKind: scope.operationKind ?? null } : null,
            version: "1.0",
          };
          break;
        }
        case "grant_capability": {
          // ADR-0052: an approval never becomes a standing grant. The
          // confirmation echoes the approved envelope only.
          executionResult = {
            kind: "scoped_grant_confirmation",
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            granted: true,
            requestId: claims.requestId,
            expiresAt: payload.expiresAt ?? null,
          };
          break;
        }
        default: {
          // Deny-by-default: any action without an implemented bounded
          // behavior is rejected, never silently acknowledged as success.
          throw forbidden("ADM capability action is not supported");
        }
      }

      if (!executed) {
        // Honest outcome: the bounded operation did not take effect (tool
        // unavailable, upstream refusal). Audit as denied, not success.
        await logActivity(db, {
          companyId: claims.targetCompanyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "adm_access_request.execution_denied",
          entityType: "adm_access_request",
          entityId: claims.requestId,
          details: {
            requestId: claims.requestId,
            sourceCompanyId: claims.sourceCompanyId,
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            action: claims.action,
            scopeHash: claims.scopeHash,
            outcome: "denied",
            reason: executionResult.reason ?? "execution_not_performed",
          },
        });
        throw forbidden("ADM capability execution did not take effect");
      }

      // 5. Immutable audit log of the execution.
      await logActivity(db, {
        companyId: claims.targetCompanyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
        action: "adm_access_request.executed",
        entityType: "adm_access_request",
        entityId: claims.requestId,
        details: {
          requestId: claims.requestId,
          sourceCompanyId: claims.sourceCompanyId,
          resourceType: claims.resourceType,
          resourceRef: claims.resourceRef,
          action: claims.action,
          scopeHash: claims.scopeHash,
          outcome: "success",
        },
      });

      return {
        executed: true,
        requestId: claims.requestId,
        resourceType: claims.resourceType as AdmResourceType,
        resourceRef: claims.resourceRef,
        action: claims.action as AdmAccessAction,
        result: executionResult,
      };
    },
  };
}
