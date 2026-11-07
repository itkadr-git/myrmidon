// server/src/myrmidon/hindsight/reflection/types.ts
//
// myrmidon(1.7 POST-TASK-REFLECT): types for role lesson records and hindsight
// reflection payload.
//
// Design: docs/myrmidon/design/post-task-reflect.md
// Task: OPE-12080 (roadmap-v1 Д16/NEW POST-TASK-REFLECT)

export const FAILURE_KINDS = ["review_changes", "error", "blocked"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export const DEFAULT_LESSON_TTL_DAYS = 30;

export interface LessonRecord {
  id: string;
  role: string;
  failure_kind: FailureKind;
  root_cause: string;
  lesson_text: string;
  expires_at_days: number;
  createdAt: string;
  expiresAt: string;
  companyId?: string | null;
  issueId?: string | null;
  issueKey?: string | null;
  runId?: string | null;
  dedupKey?: string | null;
}

export interface CreateLessonRecordInput {
  id?: string;
  role: string;
  failure_kind: FailureKind;
  root_cause: string;
  lesson_text?: string;
  expires_at_days?: number;
  createdAt?: string;
  companyId?: string | null;
  issueId?: string | null;
  issueKey?: string | null;
  runId?: string | null;
  dedupKey?: string | null;
}

export interface HindsightRetainMetadata {
  kind: "lesson";
  failure_kind: FailureKind;
  role: string;
  root_cause: string;
  expires_at: string;
  issue_key?: string | null;
  dedup_key?: string | null;
  run_id?: string | null;
  [key: string]: unknown;
}

export interface HindsightRetainItem {
  content: string;
  context: "paperclip" | string;
  document_id?: string;
  metadata: HindsightRetainMetadata;
  tags: string[];
}

export interface HindsightRetainPayload {
  bankId: string;
  items: HindsightRetainItem[];
  async?: boolean;
}

export type FailureCategorizationInput =
  | FailureKind
  | string
  | {
      failure_kind?: string;
      event?: string;
      reason?: string;
      status?: string;
      verdict?: string;
      error?: unknown;
    }
  | Error;

export interface HindsightRetainClientLike {
  retain(
    bankId: string,
    content: string,
    documentId: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): Promise<void>;
}

export interface ReflectionServiceDeps {
  hindsightClient?: HindsightRetainClientLike;
  clock?: () => Date;
  defaultTtlDays?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}
