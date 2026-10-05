// packages/shared/src/myrmidon-review-rework.ts
//
// myrmidon(REVIEW-REWORK): the shared contract of the review-return loop.
//
// A review verdict that returns a pull request for rework used to be a dead
// end: the verdict comment existed, the review task stayed wakeable, and no
// rework task was ever created — the reviewer was woken every interval on an
// unchanged head while nobody owned the fix. The board now closes the loop:
//
//   RETURN verdict -> a rework task is created (or reopened) with an
//   executor, and the review task goes to `blocked` pointing at it;
//   a new head in the PR  -> the block lifts, the review task returns to
//   `todo` and the reviewer is woken;
//   the PR merged/closed   -> the review task is closed.
//
// The settings live in `instance_settings.general.reviewRework` and are read
// on every sweep pass, so a change applies without a restart. The stored key
// is top-level (never a sub-key of a sibling feature's object): a sibling's
// own settings PATCH rewrites its namespace wholesale and would drop unknown
// keys.
//
// The verdict itself is understood in two ways, either of which opens the
// loop (the newest signal wins, and a verdict older than the last head-ack is
// answered):
//
//   1. the GitHub-native one: the PR's aggregate review decision is
//      `CHANGES_REQUESTED` at the current head;
//   2. the board-convention one: a comment on the review task carrying the
//      line `VERDICT <repo>#<number>: RETURN` (optionally with
//      `(head <sha>)`). This is the marker reviewer roles write when the PR
//      verdict is recorded on the board instead of as a GitHub review.

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its settings under. */
export const REVIEW_REWORK_SETTINGS_KEY = "reviewRework";

/** Journal key of the settings changes, newest first (mirrors `swarmClaimJournal`). */
export const REVIEW_REWORK_JOURNAL_KEY = "reviewReworkJournal";

/** Entries kept in the journal; older ones fall off the front. */
export const REVIEW_REWORK_JOURNAL_LIMIT = 50;

/**
 * Master switch. This is a defect fix, so it ships enabled (CONVENTIONS.md
 * section 8): an absent or malformed row means the defaults, and only an
 * explicit `enabled: false` turns the loop off.
 */
export const DEFAULT_REVIEW_REWORK_ENABLED = true;

/**
 * The agent a rework task falls to when neither the review task's execution
 * state nor the delivering task names an executor. `null` means "no fallback
 * assignee": the task is created unassigned in `todo`, which is exactly the
 * role-queue shape (SWARM-CLAIM) — an unassigned todo task is claimed by the
 * role's queue.
 */
export const DEFAULT_REVIEW_REWORK_FALLBACK_ASSIGNEE_AGENT_ID: string | null = null;

export const reviewReworkSettingsSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_REVIEW_REWORK_ENABLED),
    fallbackAssigneeAgentId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type ReviewReworkSettings = z.infer<typeof reviewReworkSettingsSchema>;

// Built per-field, not `.partial()` over the settings schema: partial keeps
// the field defaults, so `{}` would validate as a full "switch on" settings
// row and slip past the refine below.
export const patchReviewReworkSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    fallbackAssigneeAgentId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "The settings patch must change at least one key",
  });

export type ReviewReworkSettingsPatch = z.infer<typeof patchReviewReworkSettingsSchema>;

/** The stored settings, or the defaults when absent or unreadable. */
export function normalizeReviewReworkSettings(raw: unknown): ReviewReworkSettings {
  const parsed = reviewReworkSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enabled: parsed.data.enabled,
      fallbackAssigneeAgentId: parsed.data.fallbackAssigneeAgentId ?? null,
    };
  }
  // A hand-edited row cannot half-apply: unreadable means the defaults.
  const fallback = reviewReworkSettingsSchema.parse({});
  return {
    enabled: fallback.enabled,
    fallbackAssigneeAgentId: fallback.fallbackAssigneeAgentId ?? null,
  };
}

/** Merge a patch over the current effective settings (PATCH semantics, per key). */
export function mergeReviewReworkSettings(
  current: ReviewReworkSettings,
  patch: ReviewReworkSettingsPatch,
): ReviewReworkSettings {
  return normalizeReviewReworkSettings({
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.fallbackAssigneeAgentId !== undefined
      ? { fallbackAssigneeAgentId: patch.fallbackAssigneeAgentId }
      : {}),
  });
}

/** Origin kind of an auto-created rework task (`issues.originKind`). */
export const REVIEW_REWORK_ORIGIN_KIND = "review_rework";

/** Activity actions the loop writes (one per event, on the affected issue). */
export const REVIEW_REWORK_CREATED_ACTION = "issue.review_rework.created";
export const REVIEW_REWORK_REOPENED_ACTION = "issue.review_rework.reopened";
export const REVIEW_REWORK_BLOCKED_ACTION = "issue.review_rework.review_blocked";
export const REVIEW_REWORK_UNBLOCKED_ACTION = "issue.review_rework.review_unblocked";
export const REVIEW_REWORK_CLOSED_ACTION = "issue.review_rework.review_closed";
/** The settings-change audit row (mirrors `instance.swarm_claim.updated`). */
export const REVIEW_REWORK_SETTINGS_UPDATED_ACTION = "instance.review_rework.updated";

/** The wake reason the loop uses when it wakes the reviewer after a new head. */
export const REVIEW_REWORK_WAKE_REASON = "myrmidon_review_rework_new_head";
/** Prefix of the wake idempotency key (tracing, not a constraint). */
export const REVIEW_REWORK_WAKE_IDEMPOTENCY_PREFIX = "review_rework";

/**
 * The board-convention verdict marker. One line inside a comment, for example
 * `VERDICT itkadr-git/myrmidon#484: RETURN` or `VERDICT #484: APPROVE`; the
 * optional `(head <sha>)` part pins the verdict to an exact head. `RETURN`
 * opens the rework loop, `APPROVE` clears an outstanding return.
 */
const VERDICT_MARKER_SOURCE =
  "\\bVERDICT\\b[^\\n]*#([1-9][0-9]*)[^\\n]*?:\\s*(RETURN|REWORK|CHANGES\\s+REQUESTED|APPROVE|LGTM)\\b(?:\\s*\\(head\\s+([0-9a-f]{7,40})\\))?";

function verdictMarkerPattern(): RegExp {
  // A fresh RegExp per scan: a shared /g regex keeps lastIndex between scans
  // and would skip markers in the next comment.
  return new RegExp(VERDICT_MARKER_SOURCE, "gi");
}

export interface ReviewReworkVerdictMarker {
  /** The PR number the marker names. */
  prNumber: number;
  outcome: "return" | "approve";
  /** The head sha the marker pins the verdict to, when present. */
  headSha: string | null;
  /** The comment timestamp the marker was found in (the "verdict link" time). */
  at: string;
  /** The comment id the marker came from (linkable on the board). */
  commentId: string;
}

/** Parse verdict markers out of one comment body; every marker line yields one entry. */
export function parseReviewReworkVerdictMarkers(
  comment: { id: string; body: string; createdAt: Date | string },
): ReviewReworkVerdictMarker[] {
  const markers: ReviewReworkVerdictMarker[] = [];
  for (const match of comment.body.matchAll(verdictMarkerPattern())) {
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    markers.push({
      prNumber: number,
      outcome: /^(RETURN|REWORK|CHANGES)/i.test(match[2] ?? "") ? "return" : "approve",
      headSha: match[3] ? match[3].toLowerCase() : null,
      at: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : String(comment.createdAt),
      commentId: comment.id,
    });
  }
  return markers;
}
