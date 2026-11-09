// myrmidon(OPE-11970, REVIEW-RETURN-GUARD): the pure half of the guard that keeps
// a review return from waking the executor when there is nothing for it to do.
//
// The loop it breaks (one engineer bot, 02.11 - 06.11): the reviewer returns a
// task with REQUEST CHANGES because CI of the pull request head is red, only on
// flaky or infrastructure checks, or returns it a second time on the very same
// head. The board wakes the executor (`execution_changes_requested`). The
// executor has no commit to make, resubmits, the reviewer returns it again.
// 199 such wakes cost 520M input tokens in four days, almost all of them on
// four tasks.
//
// Two facts are enough to see a return that has nothing to do:
//
//   - the return is on the same pull request head as the previous return and
//     no commit was pushed since (head sha equal): the executor was already
//     told what to change on this head and changed nothing;
//   - every check that failed on the head is a known infrastructure check
//     (`CI result` failing alone is its own queue-latency gate, `main-green`
//     fails when main is red) and the decision comment states CI as its only
//     reason: the code is not at fault, the failed jobs need a re-run.
//
// In both cases the decision stays recorded and the executor stays assigned;
// only the wake is skipped. The board still wakes the executor when CI of the
// head completes again (`ci_completed`), on a comment, and on a new head.
//
// No database and no network here. Anything the guard cannot read means "wake":
// when unsure the old behaviour stays.

/** Kill switch. Unset or any value but an explicit off keeps the guard on. */
export const REVIEW_RETURN_GUARD_ENABLED_ENV = "MYRMIDON_REVIEW_RETURN_GUARD_ENABLED";

/**
 * Names of the checks a failure of which does not say anything about the code
 * (comma or newline separated). Unset: the defaults below. Set to an empty
 * string: no check counts as infrastructure and only the same-head rule works.
 * Names are matched whole, case-insensitively.
 */
export const REVIEW_INFRA_CHECK_NAMES_ENV = "MYRMIDON_REVIEW_INFRA_CHECK_NAMES";

/**
 * `CI result` is the aggregate of the lanes: when every other check of the head
 * passed it can only fail on its own gate (queue start latency, missing gh/jq).
 * When a lane failed, that lane is in the failed list too and the list is not
 * infrastructure-only. `main-green` fails while main CI is red and is re-run by
 * the board once main is green again.
 */
export const DEFAULT_REVIEW_INFRA_CHECK_NAMES: readonly string[] = ["CI result", "main-green"];

export const REVIEW_RETURN_SUPPRESSED_ACTION = "issue.review_return_wake_suppressed";
export const CI_INFRA_RETRY_NEEDED_ACTION = "issue.ci_infra_retry_needed";

export function readReviewReturnGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[REVIEW_RETURN_GUARD_ENABLED_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

export function readReviewInfraCheckNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[REVIEW_INFRA_CHECK_NAMES_ENV];
  if (raw === undefined) return [...DEFAULT_REVIEW_INFRA_CHECK_NAMES];
  return raw
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

const HEAD_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

/** Lower-case hex commit id, or null for anything that is not one (the head is then unknown). */
export function normalizeHeadSha(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return HEAD_SHA_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * The execution state with the head of the pull request the decision was made
 * on. A head that is not a commit id removes the mark: a return that cannot
 * name its head must not be compared with the next one.
 */
export function withChangesRequestedHeadSha<T extends object>(
  state: T,
  headSha: string | null | undefined,
): T & { lastChangesRequestedHeadSha?: string | null } {
  const next: Record<string, unknown> = { ...(state as unknown as Record<string, unknown>) };
  delete next.lastChangesRequestedHeadSha;
  const head = normalizeHeadSha(headSha);
  if (head) next.lastChangesRequestedHeadSha = head;
  return next as unknown as T & { lastChangesRequestedHeadSha?: string | null };
}

type StateWithHead = {
  status?: string | null;
  lastChangesRequestedHeadSha?: string | null;
} | null | undefined;

/**
 * The new state is a return (`changes_requested`) on the very head the previous
 * return was made on. Both heads must be known commit ids.
 */
export function repeatedReturnHead(previous: StateWithHead, next: StateWithHead): string | null {
  if (next?.status !== "changes_requested") return null;
  const nextHead = normalizeHeadSha(next.lastChangesRequestedHeadSha);
  const previousHead = normalizeHeadSha(previous?.lastChangesRequestedHeadSha);
  return nextHead && previousHead && nextHead === previousHead ? nextHead : null;
}

/** Longest decision comment still read as a CI report; longer ones are reviews of the code. */
const CI_ONLY_COMMENT_MAX_CHARS = 4000;

const CI_MENTION = /\b(ci|ci result|main-green|checks?|workflows?|pipeline|github actions)\b/i;

/** A file name with an extension, a line reference or a code fence: the comment talks about code. */
const CODE_FINDING_MARKERS: readonly RegExp[] = [
  /```/,
  /(?:^|[\s`'"(\/])[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|md|ya?ml|sh|css|go|rs|py)\b/i,
  /\bline\s+\d+/i,
  /(?<![\p{L}\d_])строк[аеиу]?\s+\d+/iu,
];

/**
 * Whether the decision comment reports the CI state and nothing about the code.
 * Deliberately narrow: it must mention CI, must stay short and must not cite a
 * source file, a line or a code block. Anything else is a code review and the
 * executor is woken.
 */
export function isCiOnlyReviewComment(body: string | null | undefined): boolean {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text || text.length > CI_ONLY_COMMENT_MAX_CHARS) return false;
  if (!CI_MENTION.test(text)) return false;
  return !CODE_FINDING_MARKERS.some((marker) => marker.test(text));
}

/** Whether the review comment references code (path:line, file name, or code fence). */
export function reviewCommentReferencesCode(body: string | null | undefined): boolean {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return false;
  return CODE_FINDING_MARKERS.some((marker) => marker.test(text));
}

/** Every failed check is on the infrastructure list, and there is at least one failed check. */
export function failedChecksAreInfraOnly(failed: readonly string[], infraNames: readonly string[]): boolean {
  if (failed.length === 0 || infraNames.length === 0) return false;
  const infra = new Set(infraNames.map((name) => name.trim().toLowerCase()));
  return failed.every((name) => infra.has(name.trim().toLowerCase()));
}

export type ReviewReturnWakeDecision =
  | { action: "wake" }
  | { action: "suppress"; reason: "repeat_same_head"; headSha: string }
  | {
      action: "suppress";
      reason: "ci_infra_only";
      headSha: string;
      failedChecks: string[];
      pullRequestUrl: string | null;
    };

function shortSha(headSha: string): string {
  return headSha.slice(0, 8);
}

/** The system note left in the task thread; the executor reads it on its next wake. */
export function buildReviewReturnSuppressedNote(
  decision: Exclude<ReviewReturnWakeDecision, { action: "wake" }>,
): string {
  if (decision.reason === "repeat_same_head") {
    return (
      `Повторный возврат на той же голове PR (${shortSha(decision.headSha)}) без нового коммита — исполнитель не будится. ` +
      "Нужен новый коммит или новые замечания к коду (комментарий в задаче)."
    );
  }
  return (
    `Возврат только из-за инфраструктурных проверок CI на голове ${shortSha(decision.headSha)} ` +
    `(упали: ${decision.failedChecks.join(", ")}) — исполнитель не будится. ` +
    "Нужен перезапуск упавших джобов (ci_infra_retry_needed); после нового результата CI доска разбудит исполнителя."
  );
}
