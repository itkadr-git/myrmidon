// server/src/myrmidon/review-rework/domain.ts
//
// myrmidon(REVIEW-REWORK): the pure half of the review-return loop. From the
// review task's stored rows, the verdict markers its comments carry, the fresh
// facts about the linked pull requests and the task's own rework child, it
// decides exactly one transition per pass:
//
//   - `close_review`    — every linked PR reached a terminal state (merged or
//     closed): the review is over, the task settles `done`;
//   - `create_rework`   — a RETURN verdict has no rework task yet: the sweep
//     opens one (executor down the ladder; unassigned = the role queue) and
//     the review task goes to `blocked` pointing at it;
//   - `reopen_rework`   — the rework task was settled but a RETURN verdict
//     newer than the last head-ack exists: the same task reopens with the new
//     verdict link;
//   - `ensure_blocked`  — the rework exists and is active but the review is
//     not blocked (a racing human, or a failed block on the previous pass):
//     only the block transition is applied, never a second task;
//   - `record_baseline` — the review waits blocked and the rework has no head
//     baseline recorded (the verdict carried no head): store the current head
//     as the baseline; the block is kept, nobody is woken;
//   - `unblock_review`  — the review waits on its rework and the PR head moved
//     past the baseline: lift the block, put the review back to `todo` and
//     (through the caller) wake the reviewer with the new head;
//   - `noop`            — anything else (waiting on the author, no verdict,
//     an unresolved PR, a state this loop does not own).
//
// No database access and no network here, the same rule as task-pr-sync's
// policy: the caller reads the rows, resolves the PR state, then packs both
// into the facts below.

import {
  parseReviewReworkVerdictMarkers,
  type ReviewReworkVerdictMarker,
} from "@paperclipai/shared";

/** Effective state of one linked PR, after the stored row and resolved facts merge. */
export type ReviewReworkPrState = "open" | "draft" | "merged" | "closed" | "unknown";

export interface ReviewReworkPrFact {
  /** `owner/repo#number`, lower-case — the join key across markers, acks, children. */
  prKey: string;
  repo: string;
  number: number;
  state: ReviewReworkPrState;
  /** Current head sha as resolved from GitHub; `null` when it could not be resolved. */
  headSha: string | null;
  /** The aggregate GitHub review decision at the head, when reported. */
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | null;
  /** The PR `updated_at` the resolver reported (ISO); the native-decision timestamp. */
  updatedAt: string | null;
}

export interface ReviewReworkTaskFacts {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  billingCode: string | null;
  priority: string | null;
  /** The agent recorded as the stage's return assignee (the author under review). */
  returnAssigneeAgentId: string | null;
}

/** The rework child of a review task (`originKind = "review_rework"`). */
export interface ReviewReworkChildFacts {
  id: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  /** Parsed from `originFingerprint` (`<prKey>@<baseline>`): the PR the child answers. */
  prKey: string | null;
  /** The head the return was recorded against; null until `record_baseline` writes it. */
  baselineHeadSha: string | null;
}

export interface ReviewReworkCommentInput {
  id: string;
  body: string;
  createdAt: Date | string;
}

export interface ReviewReworkVerdictLink {
  outcome: "return" | "approve";
  at: string;
  commentId: string | null;
  /** Where the verdict came from: a board comment marker or the GitHub review state. */
  source: "comment" | "github_review";
  /** The head sha the marker pinned, when it named one. */
  headSha: string | null;
}

export interface ReviewReworkExecutorCandidate {
  agentId: string;
  /** Why this agent is a candidate — recorded in the activity row. */
  source: "return_assignee" | "delivering_task" | "setting";
}

export interface ReviewReworkFacts {
  task: ReviewReworkTaskFacts;
  prs: ReviewReworkPrFact[];
  /** The review task's own comments (markers and acks are read from the bodies). */
  comments: ReviewReworkCommentInput[];
  /** The task's newest rework child (any status), or null when there is none. */
  child: ReviewReworkChildFacts | null;
  /**
   * The assignee of the task this PR delivers (another task's `pull_request`
   * work product), when the sweep resolved one — the ladder's second rung.
   */
  deliveringTaskAssigneeAgentId: string | null;
  /** `settings.fallbackAssigneeAgentId` as read on this pass. */
  fallbackAssigneeAgentId: string | null;
}

export type ReviewReworkNoopReason =
  | "task_state_not_review"
  | "no_linked_pr"
  | "pr_state_unknown"
  | "no_outstanding_verdict"
  | "verdict_cleared_by_approve"
  | "waiting_for_rework"
  | "head_unchanged"
  | "no_authoritative_head";

export type ReviewReworkDecision =
  | {
      kind: "close_review";
      prRefs: string[];
      outcome: "merged" | "closed";
    }
  | {
      kind: "create_rework";
      prKey: string;
      prRef: string;
      headSha: string | null;
      verdict: ReviewReworkVerdictLink;
      executorLadder: ReviewReworkExecutorCandidate[];
    }
  | {
      kind: "reopen_rework";
      child: ReviewReworkChildFacts;
      prKey: string;
      prRef: string;
      headSha: string | null;
      verdict: ReviewReworkVerdictLink;
      executorLadder: ReviewReworkExecutorCandidate[];
    }
  | {
      kind: "ensure_blocked";
      child: ReviewReworkChildFacts;
    }
  | {
      kind: "record_baseline";
      child: ReviewReworkChildFacts;
      prKey: string;
      headSha: string;
    }
  | {
      kind: "unblock_review";
      child: ReviewReworkChildFacts;
      prKey: string;
      prRef: string;
      previousHeadSha: string | null;
      headSha: string;
    }
  | { kind: "noop"; reason: ReviewReworkNoopReason };

/** Statuses the loop may act on; `in_progress` is owned by its assignee's live run. */
const REVIEW_CANDIDATE_STATUSES: ReadonlySet<string> = new Set(["backlog", "todo", "in_review", "blocked"]);
const REWORK_SETTLED_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

/** The ack line the unblock writes; verdicts older than the ack are answered. */
export const REVIEW_REWORK_HEAD_ACK_MARKER = "HEAD-ACK";

export function reviewReworkPrKey(parts: { repo: string; number: number }): string {
  return `${parts.repo.toLowerCase()}#${parts.number}`;
}

/** The stored child fingerprint: `<prKey>@<baselineSha|none>`. */
export function encodeReworkFingerprint(prKey: string, baselineHeadSha: string | null): string {
  return `${prKey}@${baselineHeadSha ?? "none"}`;
}

export function decodeReworkFingerprint(raw: string | null | undefined): {
  prKey: string | null;
  baselineHeadSha: string | null;
} {
  if (!raw) return { prKey: null, baselineHeadSha: null };
  const at = raw.lastIndexOf("@");
  if (at <= 0) return { prKey: null, baselineHeadSha: null };
  const prKey = raw.slice(0, at).toLowerCase();
  const head = raw.slice(at + 1);
  return { prKey, baselineHeadSha: head === "" || head === "none" ? null : head };
}

function noop(reason: ReviewReworkNoopReason): ReviewReworkDecision {
  return { kind: "noop", reason };
}

/** Newest-first comparator over ISO stamps; unparseable stamps sort oldest. */
function newestLink(links: readonly ReviewReworkVerdictLink[]): ReviewReworkVerdictLink | null {
  let newest: ReviewReworkVerdictLink | null = null;
  for (const link of links) {
    const at = Date.parse(link.at);
    const bestAt = newest ? Date.parse(newest.at) : Number.NaN;
    if (!newest || (Number.isFinite(at) && (!Number.isFinite(bestAt) || at >= bestAt))) newest = link;
  }
  return newest;
}

/** Every verdict marker found in the task's comments, oldest first. */
export function collectVerdictMarkers(
  comments: readonly ReviewReworkCommentInput[],
): ReviewReworkVerdictMarker[] {
  const markers: ReviewReworkVerdictMarker[] = [];
  for (const comment of comments) markers.push(...parseReviewReworkVerdictMarkers(comment));
  return markers;
}

/**
 * The last head-ack recorded per PR: a `HEAD-ACK <prKey>: <sha>` line written
 * by a previous unblock. A verdict older than the ack is answered — the author
 * already pushed against it and the reviewer has been woken.
 */
export function collectHeadAcks(
  comments: readonly ReviewReworkCommentInput[],
): Map<string, { at: string; headSha: string }> {
  const acks = new Map<string, { at: string; headSha: string }>();
  for (const comment of comments) {
    const at = comment.createdAt instanceof Date ? comment.createdAt.toISOString() : String(comment.createdAt);
    for (const line of comment.body.split("\n")) {
      const match = line.match(
        new RegExp(`${REVIEW_REWORK_HEAD_ACK_MARKER}\\s+(\\S+#\\d+):\\s*([0-9a-f]{7,40})`, "i"),
      );
      if (!match) continue;
      const key = match[1]!.toLowerCase();
      const previous = acks.get(key);
      if (!previous || Date.parse(at) >= Date.parse(previous.at)) {
        acks.set(key, { at, headSha: match[2]!.toLowerCase() });
      }
    }
  }
  return acks;
}

/**
 * The outstanding RETURN for one PR: the newest signal between a comment
 * marker and the GitHub aggregate review decision. Nothing is outstanding when
 * the last word was APPROVE, or when an ack (a push the loop already
 * recognised) is newer than the verdict.
 */
export function outstandingReturnVerdict(
  pr: ReviewReworkPrFact,
  markers: readonly ReviewReworkVerdictMarker[],
  acks: ReadonlyMap<string, { at: string; headSha: string }>,
): ReviewReworkVerdictLink | null {
  const candidates: ReviewReworkVerdictLink[] = [];
  for (const marker of markers) {
    if (`${marker.prNumber}` !== `${pr.number}`) continue;
    // A marker pinned to a head is a statement about that head only; at a
    // different head it is an answered verdict, not an outstanding one.
    if (marker.headSha && pr.headSha && marker.headSha !== pr.headSha) continue;
    candidates.push({
      outcome: marker.outcome,
      at: marker.at,
      commentId: marker.commentId,
      source: "comment",
      headSha: marker.headSha,
    });
  }
  if (pr.reviewDecision && pr.updatedAt) {
    candidates.push({
      outcome: pr.reviewDecision === "CHANGES_REQUESTED" ? "return" : "approve",
      at: pr.updatedAt,
      commentId: null,
      source: "github_review",
      headSha: null,
    });
  }
  const newest = newestLink(candidates);
  if (!newest || newest.outcome !== "return") return null;
  const ack = acks.get(pr.prKey);
  if (ack && Date.parse(ack.at) > Date.parse(newest.at)) return null;
  return newest;
}

/**
 * The executor ladder (acceptance item 1): the PR's author from the board's
 * point of view — the review stage's return assignee, the engineer who handed
 * the task to review — then the assignee of the task the PR delivers, then the
 * instance setting, then nobody: an unassigned `todo` task is exactly the
 * role-queue shape the swarm claims ("очередь роя").
 */
export function buildExecutorLadder(input: {
  task: ReviewReworkTaskFacts;
  deliveringTaskAssigneeAgentId: string | null;
  fallbackAssigneeAgentId: string | null;
}): ReviewReworkExecutorCandidate[] {
  const ladder: ReviewReworkExecutorCandidate[] = [];
  const push = (agentId: string | null | undefined, source: ReviewReworkExecutorCandidate["source"]) => {
    if (!agentId) return;
    if (!ladder.some((entry) => entry.agentId === agentId)) ladder.push({ agentId, source });
  };
  push(input.task.returnAssigneeAgentId, "return_assignee");
  push(input.deliveringTaskAssigneeAgentId, "delivering_task");
  push(input.fallbackAssigneeAgentId, "setting");
  return ladder;
}

/**
 * The decision table for one review task. The terminal PR settles the review
 * first — the reviewer's job is over whatever the verdict looked like. Then the
 * blocked review waiting on its rework is released only when the head moved
 * (with a baseline stored first when the verdict named none). Then an
 * outstanding RETURN opens, reopens, or re-blocks the rework half.
 */
export function decideReviewRework(facts: ReviewReworkFacts): ReviewReworkDecision {
  const { task, prs, child } = facts;
  if (!REVIEW_CANDIDATE_STATUSES.has(task.status)) return noop("task_state_not_review");
  if (prs.length === 0) return noop("no_linked_pr");

  const unknown = prs.filter((pr) => pr.state === "unknown");
  const known = prs.filter((pr) => pr.state !== "unknown");
  if (known.length === 0) return noop("pr_state_unknown");

  // 1. Terminal PRs close the review — but only when nothing is still moving:
  //    an open sibling or an unresolvable PR keeps the review alive.
  const terminal = known.filter((pr) => pr.state === "merged" || pr.state === "closed");
  const openish = known.filter((pr) => pr.state === "open" || pr.state === "draft");
  if (terminal.length > 0 && openish.length === 0 && unknown.length === 0) {
    return {
      kind: "close_review",
      prRefs: known.map((pr) => `${pr.repo}#${pr.number}`),
      outcome: known.some((pr) => pr.state === "merged") ? "merged" : "closed",
    };
  }

  const markers = collectVerdictMarkers(facts.comments);
  const acks = collectHeadAcks(facts.comments);

  // 2. The blocked review waiting on its rework: the head-moved release. A
  //    settled child counts too — the author may close the rework right after
  //    pushing; what releases the review is the head, not the child's status.
  if (task.status === "blocked" && child) {
    const pr = child.prKey ? known.find((entry) => entry.prKey === child.prKey) ?? null : null;
    if (!pr) {
      // A blocked review whose PR cannot be resolved stays blocked: guessing a
      // release is exactly the unchanged-lane wake this feature removes.
      return unknown.length > 0 ? noop("pr_state_unknown") : noop("no_linked_pr");
    }
    if (!pr.headSha) return noop("no_authoritative_head");
    if (!child.baselineHeadSha) {
      return { kind: "record_baseline", child, prKey: pr.prKey, headSha: pr.headSha };
    }
    if (pr.headSha === child.baselineHeadSha) return noop("head_unchanged");
    return {
      kind: "unblock_review",
      child,
      prKey: pr.prKey,
      prRef: `${pr.repo}#${pr.number}`,
      previousHeadSha: child.baselineHeadSha,
      headSha: pr.headSha,
    };
  }

  // 3. An outstanding RETURN opens (or reopens) the rework half.
  const executorLadder = buildExecutorLadder({
    task: facts.task,
    deliveringTaskAssigneeAgentId: facts.deliveringTaskAssigneeAgentId,
    fallbackAssigneeAgentId: facts.fallbackAssigneeAgentId,
  });
  for (const pr of known) {
    // A terminal PR answers a return: its head will never move again, so a
    // rework task here would hang. The sibling check above already kept the
    // review alive for an open sibling; the return now goes to the live PR.
    if (pr.state === "merged" || pr.state === "closed") continue;
    const verdict = outstandingReturnVerdict(pr, markers, acks);
    if (!verdict) continue;
    const prRef = `${pr.repo}#${pr.number}`;
    const headSha = pr.headSha ?? verdict.headSha;
    if (child && !REWORK_SETTLED_STATUSES.has(child.status)) {
      // A rework task already covers this return; the review just has to wait
      // on it. Re-asserting the block is the repair for a failed block pass.
      if (task.status !== "blocked") return { kind: "ensure_blocked", child };
      return noop("waiting_for_rework");
    }
    if (child && child.prKey === pr.prKey) {
      return {
        kind: "reopen_rework",
        child,
        prKey: pr.prKey,
        prRef,
        headSha,
        verdict,
        executorLadder,
      };
    }
    if (!child) {
      return {
        kind: "create_rework",
        prKey: pr.prKey,
        prRef,
        headSha,
        verdict,
        executorLadder,
      };
    }
  }
  if (markers.length > 0 || known.some((pr) => pr.reviewDecision !== null)) {
    return noop("verdict_cleared_by_approve");
  }
  return noop("no_outstanding_verdict");
}
