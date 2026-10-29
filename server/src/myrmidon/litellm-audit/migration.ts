// server/src/myrmidon/litellm-audit/migration.ts
//
// myrmidon(OPE-9857): audit/migration parser for historical and current audit entries.
// Migrates legacy activity_log records and structured snapshots into normalized
// LiteLlmAuditEntry representations with guaranteed secret redaction.

import { redactCredentials } from "./redaction.js";
import type { LiteLlmAuditCategory, LiteLlmAuditEntry } from "./types.js";

export interface RawAuditRow {
  id: string;
  companyId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
  createdAt?: Date | string | null;
  at?: string | null;
  timestamp?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  summary?: string | null;
  category?: string | null;
  canRollback?: boolean | null;
}

export function inferAuditCategory(action: string, entityType?: string | null): LiteLlmAuditCategory {
  const normAction = action.toLowerCase();
  const normEntity = (entityType ?? "").toLowerCase();

  if (normAction.includes("fallback") || normEntity.includes("fallback")) {
    return "fallbacks";
  }
  if (
    normAction.includes("key") ||
    normEntity.includes("key") ||
    normAction.includes("allowlist")
  ) {
    return "keys";
  }
  return "models";
}

export function isActionRollbackable(action: string, before: unknown): boolean {
  if (!before || typeof before !== "object" || Object.keys(before).length === 0) {
    return false;
  }
  const normAction = action.toLowerCase();
  if (normAction.includes("key_rotated") || normAction === "litellm_audit_rollback") {
    // Secret rotation cannot restore the old secret value because credentials are redacted.
    return false;
  }
  return true;
}

/**
 * Migrates a raw database row or legacy activity log record to a fully
 * typed and redacted LiteLlmAuditEntry.
 */
export function migrateAuditRecord(raw: RawAuditRow, fallbackCompanyId?: string): LiteLlmAuditEntry {
  const details = (raw.details ?? {}) as Record<string, unknown>;
  const action = raw.action || "unknown";
  const entityType = raw.entityType ?? (details.entityType as string | undefined);
  const category = (raw.category ?? details.category ?? inferAuditCategory(action, entityType)) as LiteLlmAuditCategory;

  const rawBefore = raw.before ?? (details.before as Record<string, unknown> | undefined);
  const rawAfter = raw.after ?? (details.after as Record<string, unknown> | undefined);

  let before: Record<string, unknown> | null = null;
  let after: Record<string, unknown> | null = null;

  if (rawBefore !== undefined) {
    before = rawBefore ? (redactCredentials(rawBefore) as Record<string, unknown>) : null;
  } else if (action === "model_provider_removed") {
    // Legacy removed entries held the previous provider view in details
    const cleaned = { ...details };
    delete cleaned.category;
    delete cleaned.summary;
    before = redactCredentials(cleaned) as Record<string, unknown>;
  }

  if (rawAfter !== undefined) {
    after = rawAfter ? (redactCredentials(rawAfter) as Record<string, unknown>) : null;
  } else if (action === "model_provider_added" || action === "model_provider_patched") {
    const cleaned = { ...details };
    delete cleaned.category;
    delete cleaned.summary;
    after = redactCredentials(cleaned) as Record<string, unknown>;
  }

  // Determine timestamp (ISO 8601 string)
  let timestamp: string;
  if (raw.createdAt instanceof Date) {
    timestamp = raw.createdAt.toISOString();
  } else if (typeof raw.createdAt === "string") {
    timestamp = new Date(raw.createdAt).toISOString();
  } else if (typeof raw.timestamp === "string") {
    timestamp = new Date(raw.timestamp).toISOString();
  } else if (typeof raw.at === "string") {
    timestamp = new Date(raw.at).toISOString();
  } else {
    timestamp = new Date().toISOString();
  }

  const rawCanRollback = raw.canRollback ?? (details.canRollback as boolean | undefined);
  const canRollback =
    typeof rawCanRollback === "boolean"
      ? rawCanRollback
      : isActionRollbackable(action, before);

  const summary =
    raw.summary ??
    (details.summary as string | undefined) ??
    `${action.replace(/_/g, " ")} (${category})`;

  const actorType = raw.actorType ?? (details.actorType as string | undefined) ?? "user";
  const actorId = raw.actorId ?? (details.actorId as string | undefined) ?? "board";
  const actorName = (details.actorName as string | undefined) ?? null;

  return {
    id: raw.id,
    companyId: raw.companyId ?? fallbackCompanyId ?? (details.companyId as string) ?? "",
    category,
    action,
    entityId: raw.entityId ?? (details.entityId as string) ?? "",
    actor: {
      type: actorType,
      id: actorId,
      name: actorName,
    },
    timestamp,
    before,
    after,
    summary,
    canRollback,
  };
}
