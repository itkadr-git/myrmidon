// server/src/myrmidon/hindsight/reflection/lesson-formatter.ts
//
// myrmidon(1.7 POST-TASK-REFLECT): formatting for role lesson records — the
// template lesson text (the no-free-model fallback of the design §4.1), the
// role bank address (§3.1), the hindsight retain payload (§3.2) and the
// deterministic dedup key (§4.2).

import { validateHindsightRetainPayload } from "./schema.js";
import type {
  FailureKind,
  HindsightRetainPayload,
  LessonRecord,
} from "./types.js";

/**
 * The role bank address of the design §3.1: `role-<companyId>-<role>`.
 * The role is lowercased so "Docs" and "docs" address one bank.
 */
export function formatRoleBankId(companyId: string, role: string): string {
  const company = companyId.trim();
  const normalizedRole = role.trim().toLowerCase();
  if (!company) throw new Error("companyId is required for a role bank id");
  if (!normalizedRole) throw new Error("role is required for a role bank id");
  return `role-${company}-${normalizedRole}`;
}

/**
 * The template lesson (design §4.1 degradation): one paragraph, first person
 * of the role, at most ~500 characters, built from the failure kind and the
 * root cause. An explicit `details` (reviewer comment, error summary, unblock
 * descriptor) is folded in when present.
 */
export function formatLessonText(input: {
  role: string;
  failure_kind: FailureKind;
  root_cause: string;
  details?: string | null;
}): string {
  const role = input.role.trim();
  const cause = input.root_cause.trim();
  const details = input.details?.trim();
  let body: string;
  switch (input.failure_kind) {
    case "review_changes":
      body =
        `When my work is returned from acceptance with "${cause}", I address ` +
        "the review feedback and re-verify the acceptance criteria before resubmitting.";
      break;
    case "error":
      body =
        `When my run fails with "${cause}", I inspect the failure logs and fix ` +
        "the root cause before retrying instead of repeating the same attempt.";
      break;
    case "blocked":
      body =
        `When my task becomes blocked on "${cause}", I surface the blocker early ` +
        "and prepare everything around it so work resumes immediately once it clears.";
      break;
    default: {
      const exhaustive: never = input.failure_kind;
      throw new Error(`unknown failure kind: ${String(exhaustive)}`);
    }
  }
  const text = details ? `${body} Context: ${details}.` : body;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/** The task anchor of the design §3.2: `issue:<issueId>` as the document id. */
export function formatDocumentId(issueId?: string | null): string | undefined {
  const trimmed = issueId?.trim();
  return trimmed ? `issue:${trimmed}` : undefined;
}

/** The tag set of the design §3.2 — what the memory card displays. */
export function formatLessonTags(lesson: Pick<LessonRecord, "failure_kind" | "role">): string[] {
  return [
    "lesson",
    "post-task-reflect",
    `event:${lesson.failure_kind}`,
    `role:${lesson.role.trim().toLowerCase()}`,
  ];
}

/**
 * The deterministic dedup key of the design §4.2:
 * `<issueId>:<event>:<outcomeRevision>`.
 */
export function formatDedupKey(
  issueId: string,
  event: FailureKind,
  outcomeRevision: string | number,
): string {
  return `${issueId}:${event}:${outcomeRevision}`;
}

/**
 * Build the hindsight retain payload for one lesson (design §3.2) and
 * validate it before anything is sent: the acceptance criterion requires the
 * schema check to happen before the hindsight call, and this is the single
 * place the payload exists.
 */
export function formatHindsightRetainPayload(
  lesson: LessonRecord,
  options: { companyId?: string | null; async?: boolean } = {},
): HindsightRetainPayload {
  const companyId = options.companyId ?? lesson.companyId ?? null;
  if (!companyId) {
    throw new Error("companyId is required to address the role bank");
  }
  const bankId = formatRoleBankId(companyId, lesson.role);
  const payload: HindsightRetainPayload = {
    bankId,
    items: [
      {
        content: lesson.lesson_text,
        context: "paperclip",
        document_id: formatDocumentId(lesson.issueId),
        metadata: {
          kind: "lesson",
          failure_kind: lesson.failure_kind,
          event: lesson.failure_kind,
          role: lesson.role.trim().toLowerCase(),
          root_cause: lesson.root_cause,
          expires_at: lesson.expiresAt,
          issue_key: lesson.issueKey ?? null,
          dedup_key: lesson.dedupKey ?? null,
          run_id: lesson.runId ?? null,
        },
        tags: formatLessonTags(lesson),
      },
    ],
    async: options.async ?? true,
  };
  // Validate before returning: the caller sends this payload as-is.
  validateHindsightRetainPayload(payload);
  return payload;
}
