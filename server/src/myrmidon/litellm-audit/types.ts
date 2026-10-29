// server/src/myrmidon/litellm-audit/types.ts
//
// myrmidon(OPE-9857): audit log of models, fallbacks, and keys changes
// with safe single-action rollback.

export type LiteLlmAuditCategory = "models" | "fallbacks" | "keys";

export interface LiteLlmAuditActor {
  type: string; // "board" | "user" | "agent" | "system"
  id: string;
  name?: string | null;
}

export interface LiteLlmAuditEntry {
  id: string;
  companyId: string;
  category: LiteLlmAuditCategory;
  action: string;
  entityId: string;
  actor: LiteLlmAuditActor;
  timestamp: string; // ISO 8601
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  summary: string;
  canRollback: boolean;
}

export interface RecordLiteLlmAuditInput {
  companyId: string;
  category: LiteLlmAuditCategory;
  action: string;
  entityId: string;
  actor: LiteLlmAuditActor;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  summary?: string;
  canRollback?: boolean;
}

export interface RollbackLiteLlmAuditInput {
  companyId: string;
  auditId: string;
  actor: LiteLlmAuditActor;
}

export interface RollbackExecutionResult {
  success: boolean;
  auditId: string;
  restoredState: Record<string, unknown> | null;
  rollbackEntry: LiteLlmAuditEntry;
}
