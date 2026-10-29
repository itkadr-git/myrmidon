// server/src/myrmidon/litellm-audit/service.ts
//
// myrmidon(OPE-9857): LiteLLM settings audit service and rollback logic.

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { activityLog } from "@myrmidon/db";
import { badRequest, HttpError, notFound } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";
import { migrateAuditRecord, type RawAuditRow } from "./migration.js";
import { redactCredentials } from "./redaction.js";
import type {
  LiteLlmAuditCategory,
  LiteLlmAuditEntry,
  RecordLiteLlmAuditInput,
  RollbackExecutionResult,
  RollbackLiteLlmAuditInput,
} from "./types.js";

export interface LiteLlmRollbackHandlers {
  restoreModels?: (companyId: string, providerId: string, models: unknown) => Promise<void>;
  restoreProvider?: (companyId: string, providerId: string, state: unknown) => Promise<void>;
  restoreFallbacks?: (companyId: string, fallbacks: unknown) => Promise<void>;
  restoreKeys?: (companyId: string, state: unknown) => Promise<void>;
}

export interface LiteLlmAuditService {
  record(input: RecordLiteLlmAuditInput): Promise<LiteLlmAuditEntry>;
  list(
    companyId: string,
    options?: { category?: LiteLlmAuditCategory; limit?: number },
  ): Promise<LiteLlmAuditEntry[]>;
  get(companyId: string, auditId: string): Promise<LiteLlmAuditEntry | null>;
  rollback(
    input: RollbackLiteLlmAuditInput,
    handlers?: LiteLlmRollbackHandlers,
  ): Promise<RollbackExecutionResult>;
}

const AUDIT_ENTITY_TYPES = [
  "litellm_audit",
  "model_provider",
  "litellm_keys",
  "litellm_key",
  "litellm_fallbacks",
];

export function createLiteLlmAuditService(db: Db): LiteLlmAuditService {
  return {
    async record(input: RecordLiteLlmAuditInput): Promise<LiteLlmAuditEntry> {
      const sanitizedBefore = input.before ? (redactCredentials(input.before) as Record<string, unknown>) : null;
      const sanitizedAfter = input.after ? (redactCredentials(input.after) as Record<string, unknown>) : null;

      const summary =
        input.summary ??
        `${input.action.replace(/_/g, " ")} (${input.category})`;

      const canRollback =
        input.canRollback !== undefined
          ? input.canRollback
          : sanitizedBefore !== null && Object.keys(sanitizedBefore).length > 0;

      const details: Record<string, unknown> = {
        category: input.category,
        before: sanitizedBefore,
        after: sanitizedAfter,
        summary,
        canRollback,
        actorType: input.actor.type,
        actorId: input.actor.id,
        actorName: input.actor.name ?? null,
      };

      const created = await logActivity(db, {
        companyId: input.companyId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: input.action,
        entityType: "litellm_audit",
        entityId: input.entityId,
        details,
      });

      return migrateAuditRecord(
        {
          id: created.id,
          companyId: created.companyId,
          actorType: created.actorType,
          actorId: created.actorId,
          action: created.action,
          entityType: created.entityType,
          entityId: created.entityId,
          details: created.details,
          createdAt: created.createdAt,
        },
        input.companyId,
      );
    },

    async list(
      companyId: string,
      options?: { category?: LiteLlmAuditCategory; limit?: number },
    ): Promise<LiteLlmAuditEntry[]> {
      const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);

      const rows = await db
        .select({
          id: activityLog.id,
          companyId: activityLog.companyId,
          actorType: activityLog.actorType,
          actorId: activityLog.actorId,
          action: activityLog.action,
          entityType: activityLog.entityType,
          entityId: activityLog.entityId,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            inArray(activityLog.entityType, AUDIT_ENTITY_TYPES),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(limit);

      const entries = rows.map((row) =>
        migrateAuditRecord(row as RawAuditRow, companyId),
      );

      if (options?.category) {
        return entries.filter((e) => e.category === options.category);
      }
      return entries;
    },

    async get(companyId: string, auditId: string): Promise<LiteLlmAuditEntry | null> {
      const [row] = await db
        .select({
          id: activityLog.id,
          companyId: activityLog.companyId,
          actorType: activityLog.actorType,
          actorId: activityLog.actorId,
          action: activityLog.action,
          entityType: activityLog.entityType,
          entityId: activityLog.entityId,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.id, auditId),
          ),
        )
        .limit(1);

      if (!row) return null;
      return migrateAuditRecord(row as RawAuditRow, companyId);
    },

    async rollback(
      input: RollbackLiteLlmAuditInput,
      handlers?: LiteLlmRollbackHandlers,
    ): Promise<RollbackExecutionResult> {
      // Re-authorization check: only board/user actors with board privileges can execute rollbacks
      if (input.actor.type !== "board" && input.actor.type !== "user") {
        throw new HttpError(403, "Rollback requires board authorization (re-authorization failed)");
      }

      const entry = await this.get(input.companyId, input.auditId);
      if (!entry) {
        throw notFound("Audit entry not found");
      }

      if (!entry.canRollback || !entry.before || Object.keys(entry.before).length === 0) {
        throw badRequest(
          `Audit entry "${entry.action}" cannot be rolled back: no previous non-secret state available`,
          { code: "audit_rollback_unavailable" },
        );
      }

      // Restore non-secret state depending on category and action
      if (entry.category === "models") {
        if (entry.action === "model_provider_models_updated" && handlers?.restoreModels) {
          const models = (entry.before as { models?: unknown }).models ?? entry.before;
          await handlers.restoreModels(input.companyId, entry.entityId, models);
        } else if (handlers?.restoreProvider) {
          await handlers.restoreProvider(input.companyId, entry.entityId, entry.before);
        }
      } else if (entry.category === "fallbacks" && handlers?.restoreFallbacks) {
        await handlers.restoreFallbacks(input.companyId, entry.before);
      } else if (entry.category === "keys" && handlers?.restoreKeys) {
        await handlers.restoreKeys(input.companyId, entry.before);
      }

      // Record rollback event in audit log
      const rollbackEntry = await this.record({
        companyId: input.companyId,
        category: entry.category,
        action: "litellm_audit_rollback",
        entityId: entry.entityId,
        actor: input.actor,
        before: entry.after,
        after: entry.before,
        summary: `Rolled back ${entry.action} (${entry.id.slice(0, 8)}) from ${entry.timestamp}`,
        canRollback: false, // Cannot recursively roll back a rollback
      });

      return {
        success: true,
        auditId: entry.id,
        restoredState: entry.before,
        rollbackEntry,
      };
    },
  };
}
