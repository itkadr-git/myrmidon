// server/src/myrmidon/hindsight/reflection/service.ts
//
// myrmidon(1.7 POST-TASK-REFLECT): the lesson service — failure
// categorization, lesson record creation with the 30-day default expiry, and
// the validated hindsight submit. Design: docs/myrmidon/design/post-task-reflect.md
// §2 (events), §3 (record), §4 (failure behaviour: the submit never crashes
// the caller — the board's status transition is never rolled back).

import { randomUUID } from "node:crypto";

import {
  LessonSchemaValidationError,
  validateHindsightRetainPayload,
  validateLessonRecord,
  validateLessonRecordInput,
} from "./schema.js";
import {
  formatHindsightRetainPayload,
  formatLessonText,
} from "./lesson-formatter.js";
import {
  DEFAULT_LESSON_TTL_DAYS,
  FAILURE_KINDS,
  type CreateLessonRecordInput,
  type FailureCategorizationInput,
  type FailureKind,
  type HindsightRetainClientLike,
  type HindsightRetainPayload,
  type LessonRecord,
  type ReflectionServiceDeps,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const REVIEW_CHANGES_TRIGGERS = new Set([
  "review_changes",
  "review_change",
  "review_return",
  "return_from_acceptance",
  "request_changes",
  "changes_requested",
  "review_rejected",
  "rejected",
  "has_changes_requested",
  "review",
  "remarks",
  "changes",
]);

const ERROR_TRIGGERS = new Set([
  "error",
  "run_error",
  "run_failed",
  "failed",
  "failure",
  "heartbeat_error",
  "crashed",
  "exception",
]);

const BLOCKED_TRIGGERS = new Set([
  "blocked",
  "issue_blocked",
  "block",
  "blocked_transition",
  "stuck",
  "unblock_descriptor",
]);

function normalizedKey(value: string): string {
  return value.trim().toLowerCase();
}

function classifyWord(word: string): FailureKind | null {
  const key = normalizedKey(word);
  if (REVIEW_CHANGES_TRIGGERS.has(key)) return "review_changes";
  if (ERROR_TRIGGERS.has(key)) return "error";
  if (BLOCKED_TRIGGERS.has(key)) return "blocked";
  return null;
}

/**
 * Categorize a failure event into the lesson's `failure_kind` (the acceptance
 * criterion "correct failure categorization"). Accepts the kind itself, a
 * free-form event/verdict/status word, an `Error`, or an event object with
 * any of the fields the board puts on transitions
 * (`failure_kind` / `event` / `status` / `verdict` / `reason`).
 * Returns null when nothing in the input names a known failure kind.
 */
export function categorizeFailureOrNull(input: FailureCategorizationInput): FailureKind | null {
  if (typeof input === "string") {
    const direct = classifyWord(input);
    if (direct) return direct;
    // Free-form text ("run failed with X", "issue was blocked on Y"): the
    // first known trigger word wins.
    for (const word of normalizedKey(input).split(/[^a-z_]+/)) {
      const hit = classifyWord(word);
      if (hit) return hit;
    }
    return null;
  }
  if (input instanceof Error) return "error";
  const record = input as Record<string, unknown>;
  for (const field of ["failure_kind", "event", "status", "verdict", "reason"] as const) {
    const value = record[field];
    if (typeof value === "string") {
      const hit = classifyWord(value) ?? categorizeFailureOrNull(value);
      if (hit) return hit;
    }
  }
  if (record.error instanceof Error) return "error";
  return null;
}

/**
 * Strict categorization: unknown input is a programming error at the hook
 * site, so it throws instead of silently writing a wrongly-tagged lesson.
 */
export function categorizeFailure(input: FailureCategorizationInput): FailureKind {
  const kind = categorizeFailureOrNull(input);
  if (!kind) {
    throw new Error(`cannot categorize failure from: ${JSON.stringify(String(input)).slice(0, 120)}`);
  }
  return kind;
}

/** ISO timestamp = created + ttl days (the design's `expires_at`). */
export function computeExpiresAt(createdAt: Date, expiresAtDays: number = DEFAULT_LESSON_TTL_DAYS): string {
  return new Date(createdAt.getTime() + expiresAtDays * DAY_MS).toISOString();
}

export interface CreateLessonOptions {
  clock?: () => Date;
  /** Default TTL when the input omits `expires_at_days` (default 30). */
  defaultTtlDays?: number;
}

/**
 * Create a lesson record: the default expiry is 30 days
 * (`expires_at_days = 30`, `expiresAt` = creation + 30 days — the acceptance
 * criterion), the template lesson text fills in when no analysis text is
 * given, and the finished record is schema-valid by construction.
 */
export function createLessonRecord(
  input: CreateLessonRecordInput,
  options: CreateLessonOptions = {},
): LessonRecord {
  const parsed = validateLessonRecordInput(input);
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const createdAt = parsed.createdAt ?? now.toISOString();
  const createdDate = new Date(createdAt);
  if (Number.isNaN(createdDate.getTime())) {
    throw new Error(`invalid createdAt: ${createdAt}`);
  }
  const expiresAtDays = parsed.expires_at_days ?? options.defaultTtlDays ?? DEFAULT_LESSON_TTL_DAYS;
  const lessonText =
    parsed.lesson_text ??
    formatLessonText({ role: parsed.role, failure_kind: parsed.failure_kind, root_cause: parsed.root_cause });
  const record: LessonRecord = {
    id: parsed.id ?? randomUUID(),
    role: parsed.role.trim(),
    failure_kind: parsed.failure_kind,
    root_cause: parsed.root_cause.trim(),
    lesson_text: lessonText,
    expires_at_days: expiresAtDays,
    createdAt,
    expiresAt: computeExpiresAt(createdDate, expiresAtDays),
    companyId: parsed.companyId ?? null,
    issueId: parsed.issueId ?? null,
    issueKey: parsed.issueKey ?? null,
    runId: parsed.runId ?? null,
    dedupKey: parsed.dedupKey ?? null,
  };
  return validateLessonRecord(record) as unknown as LessonRecord;
}

export interface ReflectionService {
  /** Categorize a failure event (throws on unknown input). */
  categorize(input: FailureCategorizationInput): FailureKind;
  /** Create a schema-valid lesson record (30-day default expiry). */
  createLesson(input: CreateLessonRecordInput, options?: CreateLessonOptions): LessonRecord;
  /** Build + validate the hindsight payload for a lesson. */
  prepareRetainPayload(
    lesson: LessonRecord,
    options?: { companyId?: string | null; async?: boolean },
  ): HindsightRetainPayload;
  /**
   * Validate the payload, then retain. Validation failures throw (the record
   * would be rejected downstream); transport failures are returned as
   * `{ success: false }` — per design §4.3 the caller's transition is never
   * rolled back and never waits on the memory service.
   */
  submitLesson(
    lesson: LessonRecord,
    options?: { companyId?: string | null; async?: boolean },
  ): Promise<{ success: boolean; bankId: string; reason?: string }>;
}

export function createReflectionService(deps: ReflectionServiceDeps = {}): ReflectionService {
  const clock = deps.clock ?? (() => new Date());
  const defaultTtlDays = deps.defaultTtlDays ?? DEFAULT_LESSON_TTL_DAYS;
  const client: HindsightRetainClientLike | undefined = deps.hindsightClient;
  return {
    categorize(input: FailureCategorizationInput): FailureKind {
      return categorizeFailure(input);
    },
    createLesson(input: CreateLessonRecordInput, options?: CreateLessonOptions): LessonRecord {
      return createLessonRecord(input, { clock, defaultTtlDays, ...options });
    },
    prepareRetainPayload(
      lesson: LessonRecord,
      options?: { companyId?: string | null; async?: boolean },
    ): HindsightRetainPayload {
      return formatHindsightRetainPayload(lesson, options);
    },
    async submitLesson(
      lesson: LessonRecord,
      options?: { companyId?: string | null; async?: boolean },
    ) {
      let payload: HindsightRetainPayload;
      try {
        payload = this.prepareRetainPayload(lesson, options);
      } catch (error) {
        // Schema validation failed — the record never reaches hindsight.
        return {
          success: false,
          bankId: "",
          reason: error instanceof LessonSchemaValidationError ? error.message : String(error),
        };
      }
      const validated = validateHindsightRetainPayload(payload);
      const bankId = validated.bankId;
      if (!client) {
        return { success: false, bankId, reason: "no hindsight client configured" };
      }
      const item = validated.items[0];
      try {
        await client.retain(bankId, item.content, item.document_id, item.metadata);
        return { success: true, bankId };
      } catch (error) {
        return { success: false, bankId, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export { FAILURE_KINDS };
