import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { approvals } from "@myrmidon/db";
import {
  ADM_ACCESS_REQUEST_TYPE,
  admScopeHash,
  createAdmCapabilityToken,
  redactedAdmRequestProjection,
  verifyAdmCapabilityToken,
  type AdmAccessAction,
  type AdmCapabilityClaims,
  type AdmRequestStatus,
  type AdmResourceType,
  type CreateAdmAccessRequestInput,
  type DecideAdmAccessRequestInput,
  type ExecuteAdmCapabilityInput,
  type RevokeAdmAccessRequestInput,
  type RedactedAdmRequest,
} from "@myrmidon/shared";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";

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

export function admAccessRequestService(db: Db) {
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

      // 4. Safe execution projection: never returns raw secrets or cross-tenant sensitive data.
      let executionResult: Record<string, unknown>;
      switch (claims.action) {
        case "read_metadata": {
          executionResult = {
            kind: "metadata_projection",
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            scopeHash: claims.scopeHash,
            available: true,
            version: "1.0",
          };
          break;
        }
        case "query_aggregate": {
          executionResult = {
            kind: "aggregate_metrics",
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            count: 1,
            sampleAt: new Date().toISOString(),
          };
          break;
        }
        case "invoke_tool": {
          executionResult = {
            kind: "tool_execution_result",
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            status: "succeeded",
            output: "Executed via ADM controlled gateway",
          };
          break;
        }
        case "grant_capability": {
          executionResult = {
            kind: "scoped_grant_confirmation",
            resourceType: claims.resourceType,
            resourceRef: claims.resourceRef,
            granted: true,
          };
          break;
        }
        default: {
          executionResult = { status: "acknowledged" };
        }
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
