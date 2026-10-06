// server/src/myrmidon/review-rework/sweep.ts
//
// myrmidon(REVIEW-REWORK): the periodic review-return loop.
//
// One pass per interval, per company, with the settings read fresh every pass
// (a change applies without a restart):
//
//  1. a RETURN verdict (a `VERDICT …#<N>: RETURN` marker on the review task,
//     or the PR's aggregate GitHub CHANGES_REQUESTED decision — the newest
//     signal, and newer than the last head-ack) with no rework task opens one:
//     the executor follows the ladder (return assignee → delivering task's
//     assignee → the instance setting → nobody = the role queue). The review
//     task goes to `blocked` pointing at the rework, so the reviewer stops
//     being woken on an unchanged lane;
//  2. the PR head moving while the review is blocked on its rework lifts the
//     block: the task returns to `todo`, a `HEAD-ACK <pr>: <sha>` line records
//     the head the reviewer will find (which retires the verdict signal), and
//     the reviewer is woken. The first sight of a head for a verdict that
//     pinned none only stores the baseline;
//  3. every linked PR merged or closed settles the review `done` with one
//     neutral comment — the reviewer's job is over;
//  4. a settled rework with a newer outstanding RETURN reopens the same task
//     with the new verdict link instead of creating a duplicate.
//
// Idempotency: the create carries an idempotency key; the child's origin
// fingerprint (`<prKey>@<baseline>`) is the durable verdict→task link; the
// head-ack comment makes an answered verdict stop matching; every status write
// is guarded under a row lock through the issue service. The GitHub resolver
// is injected, so tests never touch the network.

import type { Logger } from "pino";
import {
  REVIEW_REWORK_BLOCKED_ACTION,
  REVIEW_REWORK_CLOSED_ACTION,
  REVIEW_REWORK_CREATED_ACTION,
  REVIEW_REWORK_ORIGIN_KIND,
  REVIEW_REWORK_REOPENED_ACTION,
  REVIEW_REWORK_UNBLOCKED_ACTION,
  REVIEW_REWORK_WAKE_IDEMPOTENCY_PREFIX,
  REVIEW_REWORK_WAKE_REASON,
  type ReviewReworkSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import {
  REVIEW_REWORK_HEAD_ACK_MARKER,
  decideReviewRework,
  encodeReworkFingerprint,
  reviewReworkPrKey,
  type ReviewReworkDecision,
  type ReviewReworkExecutorCandidate,
  type ReviewReworkPrFact,
} from "./domain.js";
import type { ReviewReworkPrResolver } from "./resolver.js";
import type { ReworkCandidateRow, ReviewReworkStore } from "./store.js";

export const DEFAULT_REVIEW_REWORK_SWEEP_INTERVAL_SEC = 60;
/** Candidates inspected per company per pass (oldest update first). */
export const REVIEW_REWORK_PAGE_SIZE = 200;
/** Moves (create/reopen/block/unblock/close) per company per pass. */
export const REVIEW_REWORK_MAX_MOVES_PER_PASS = 20;
export const REVIEW_REWORK_ACTOR_ID = "review_rework_sweep";

const FULL_PR_REFERENCE_PATTERN =
  /(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/pull)?#([1-9][0-9]*)\b/g;
const GITHUB_URL_PR_PATTERN =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/g;
const BARE_PR_NUMBER_PATTERN = /(?:\bPR\b|#)\s*#?([1-9][0-9]*)\b/gi;
const REPO_TOKEN_PATTERN = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g;

export interface ReviewReworkSweepResult {
  skippedPass: boolean;
  scanned: number;
  reworkCreated: number;
  reworkReopened: number;
  blocked: number;
  unblocked: number;
  closed: number;
  baselinesRecorded: number;
  failed: number;
}

export interface ReviewReworkSweepDeps {
  store: ReviewReworkStore;
  /** The GitHub seam (state, head sha, review decision, updated_at). */
  resolvePr: ReviewReworkPrResolver;
  readSettings: () => Promise<ReviewReworkSettings>;
  /** Heartbeat wake path; every existing gate (pause, budget, admission) applies. */
  enqueueWake: (
    agentId: string,
    wake: {
      source: "assignment";
      triggerDetail: "system";
      reason: string;
      payload: Record<string, unknown>;
      idempotencyKey?: string;
      requestedByActorType: "system";
      requestedByActorId: string;
      contextSnapshot: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  logActivity: (input: {
    companyId: string;
    action: string;
    issueId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  isUnderMaintenance?: () => Promise<boolean>;
  intervalMs?: number;
  now?: () => Date;
  log?: Pick<Logger, "info" | "warn">;
}

export interface ReviewReworkSweep {
  sweep(now?: Date, options?: { force?: boolean }): Promise<ReviewReworkSweepResult>;
  resetForTest(): void;
}

/**
 * PR coordinates the task's text names. Full `owner/repo#N`, URL and the
 * task's own work products are exact. A bare `#N` is paired with the text's
 * repo-looking tokens only when exactly one repo appears (two repos with one
 * bare number is ambiguous — the loop then acts only on the explicit forms);
 * the resolver's answer is the final check, so a wrong pairing resolves as
 * `unknown` and moves nothing.
 */
export function extractPrCoordinates(
  parts: readonly string[],
  known: readonly { repo: string; number: number }[],
): Array<{ repo: string; number: number }> {
  const out = new Map<string, { repo: string; number: number }>();
  for (const entry of known) out.set(reviewReworkPrKey(entry), entry);
  const add = (repo: string, number: number) => {
    const entry = { repo: repo.toLowerCase(), number };
    out.set(reviewReworkPrKey(entry), entry);
  };
  for (const text of parts) {
    for (const match of text.matchAll(new RegExp(GITHUB_URL_PR_PATTERN.source, "g"))) add(`${match[1]}/${match[2]}`, Number(match[3]));
    for (const match of text.matchAll(new RegExp(FULL_PR_REFERENCE_PATTERN.source, "g"))) add(`${match[1]}/${match[2]}`, Number(match[3]));
  }
  if (out.size === 0) {
    const repos = new Set<string>();
    const numbers = new Set<number>();
    for (const text of parts) {
      for (const match of text.matchAll(new RegExp(REPO_TOKEN_PATTERN.source, "g"))) {
        const candidate = match[1]!.toLowerCase();
        // A path-looking token (docs/myrmidon, src/index.ts) is not a repo;
        // a dotted token usually is (itkadr-git/myrmidon).
        if (!candidate.includes(".") || candidate.split("/")[0]?.includes(".")) {
          if (!["http", "https"].includes(candidate.split("/")[0]!)) repos.add(candidate);
        }
      }
      for (const match of text.matchAll(new RegExp(BARE_PR_NUMBER_PATTERN.source, "gi"))) {
        numbers.add(Number(match[1]));
      }
    }
    if (repos.size === 1) {
      const repo = [...repos][0]!;
      for (const number of numbers) add(repo, number);
    }
  }
  return [...out.values()];
}

function reworkTitle(reviewIdentifier: string | null, prRef: string): string {
  const origin = reviewIdentifier ? `review ${reviewIdentifier}` : "review";
  return `Rework requested (${origin}): PR ${prRef}`;
}

function reworkDescription(input: {
  reviewIdentifier: string | null;
  reviewIssueId: string;
  prRef: string;
  headSha: string | null;
  verdictAt: string;
  verdictCommentId: string | null;
  verdictSource: "comment" | "github_review";
}): string {
  const headLine = input.headSha
    ? `Head at verdict: \`${input.headSha}\``
    : "Head at verdict: not recorded (the loop pins the current head on its next pass).";
  const linkLine =
    input.verdictSource === "comment" && input.verdictCommentId
      ? `Verdict: comment \`${input.verdictCommentId}\` on the review task (${input.verdictAt}).`
      : `Verdict: GitHub review decision at ${input.verdictAt}.`;
  return [
    `The review returned pull request ${input.prRef} for rework. This task is opened automatically so a returned verdict never hangs unowned.`,
    "",
    `- PR: https://github.com/${input.prRef.replace("#", "/pull/")}`,
    `- ${headLine}`,
    `- ${linkLine}`,
    `- Review task: \`${input.reviewIdentifier ?? input.reviewIssueId}\` — it stays blocked on this task and is released automatically when the PR head moves.`,
    "",
    "To deliver: push the fixes to the PR branch. The board notices the new head, wakes the reviewer, and this task closes with the review.",
  ].join("\n");
}

export function createReviewReworkSweep(deps: ReviewReworkSweepDeps): ReviewReworkSweep {
  const intervalMs = deps.intervalMs ?? DEFAULT_REVIEW_REWORK_SWEEP_INTERVAL_SEC * 1000;
  const log = deps.log ?? logger;
  let lastSweepAtMs = 0;

  async function prFacts(
    row: ReworkCandidateRow,
    commentBodies: readonly string[],
  ): Promise<ReviewReworkPrFact[]> {
    const coordinates = extractPrCoordinates(
      [...row.textParts, ...commentBodies],
      row.products.map((product) => ({ repo: product.repo, number: product.number })),
    );
    const facts: ReviewReworkPrFact[] = [];
    for (const coordinate of coordinates) {
      const [owner, repo] = coordinate.repo.split("/");
      let snapshot = null;
      if (owner && repo) {
        try {
          snapshot = await deps.resolvePr(row.task.companyId, { owner, repo, number: coordinate.number });
        } catch {
          snapshot = null;
        }
      }
      facts.push({
        prKey: reviewReworkPrKey(coordinate),
        repo: coordinate.repo,
        number: coordinate.number,
        state: snapshot?.state ?? "unknown",
        headSha: snapshot?.headSha ?? null,
        reviewDecision: snapshot?.reviewDecision ?? null,
        updatedAt: snapshot?.updatedAt ?? null,
      });
    }
    return facts;
  }

  async function firstInvokableExecutor(
    companyId: string,
    ladder: readonly ReviewReworkExecutorCandidate[],
  ): Promise<ReviewReworkExecutorCandidate | null> {
    if (ladder.length === 0) return null;
    const invokable = await deps.store.invokableAgentIds(companyId, ladder.map((entry) => entry.agentId));
    for (const candidate of ladder) {
      if (invokable.has(candidate.agentId)) return candidate;
    }
    return null;
  }

  async function wake(
    agentId: string,
    issueId: string,
    reason: string,
    mutation: string,
    idempotencyKey: string,
    snapshot: Record<string, unknown>,
  ) {
    try {
      await deps.enqueueWake(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason,
        payload: { issueId, mutation },
        idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: REVIEW_REWORK_ACTOR_ID,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: reason, source: "myrmidon.review_rework", ...snapshot },
      });
    } catch (err) {
      log.warn({ err, issueId, agentId }, "review rework wake failed after the move was committed");
    }
  }

  async function sweepCompany(
    companyId: string,
    settings: ReviewReworkSettings,
    now: Date,
    result: ReviewReworkSweepResult,
    moves: { count: number },
  ): Promise<void> {
    const rows = await deps.store.listCandidateTasks(companyId, REVIEW_REWORK_PAGE_SIZE);
    result.scanned += rows.length;
    for (const row of rows) {
      if (moves.count >= REVIEW_REWORK_MAX_MOVES_PER_PASS) return;
      try {
        const moved = await processTask(row, settings, now, result, moves);
        if (moved) moves.count += 1;
      } catch (err) {
        result.failed += 1;
        log.warn({ err, issueId: row.task.id }, "review rework failed to process a review task");
      }
    }
  }

  async function processTask(
    row: ReworkCandidateRow,
    settings: ReviewReworkSettings,
    now: Date,
    result: ReviewReworkSweepResult,
    _moves: { count: number },
  ): Promise<boolean> {
    const { task } = row;
    const comments = await deps.store.listComments(task.id);
    const child = await deps.store.findReworkChild(task.companyId, task.id);
    const prs = await prFacts(row, comments.map((comment) => comment.body));
    if (prs.length === 0) return false;
    // The delivering task's assignee: the first PR with coordinates that names
    // a task other than this review.
    let deliveringTaskAssigneeAgentId: string | null = null;
    for (const pr of prs) {
      if (pr.state === "unknown") continue;
      deliveringTaskAssigneeAgentId = await deps.store.deliveringTaskAssignee(
        task.companyId,
        { repo: pr.repo, number: pr.number },
        task.id,
      );
      if (deliveringTaskAssigneeAgentId) break;
    }
    const decision = decideReviewRework({
      task,
      prs,
      comments: comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt })),
      child,
      deliveringTaskAssigneeAgentId,
      fallbackAssigneeAgentId: settings.fallbackAssigneeAgentId ?? null,
    });
    void now;
    return applyDecision(row, prs, decision, result);
  }

  async function applyDecision(
    row: ReworkCandidateRow,
    prs: readonly ReviewReworkPrFact[],
    decision: ReviewReworkDecision,
    result: ReviewReworkSweepResult,
  ): Promise<boolean> {
    const { task } = row;
    switch (decision.kind) {
      case "close_review": {
        const closed = await deps.store.closeReviewTask({
          issueId: task.id,
          companyId: task.companyId,
          expectStatus: task.status,
          comment:
            `Review closed: PR ${decision.prRefs.join(", ")} is ${decision.outcome}, so the review has no` +
            " next state. Settled by the review-return loop.",
        });
        if (!closed) return false;
        result.closed += 1;
        await deps.logActivity({
          companyId: task.companyId,
          action: REVIEW_REWORK_CLOSED_ACTION,
          issueId: task.id,
          details: { reason: "pr_terminal", outcome: decision.outcome, prRefs: decision.prRefs },
        });
        return true;
      }
      case "create_rework":
      case "reopen_rework": {
        const executor = await firstInvokableExecutor(task.companyId, decision.executorLadder);
        const fingerprint = encodeReworkFingerprint(decision.prKey, decision.headSha);
        const description = reworkDescription({
          reviewIdentifier: task.identifier,
          reviewIssueId: task.id,
          prRef: decision.prRef,
          headSha: decision.headSha,
          verdictAt: decision.verdict.at,
          verdictCommentId: decision.verdict.commentId,
          verdictSource: decision.verdict.source,
        });
        let reworkIssueId: string;
        let reworkIdentifier: string | null;
        if (decision.kind === "create_rework") {
          const created = await deps.store.createReworkTask({
            companyId: task.companyId,
            title: reworkTitle(task.identifier, decision.prRef),
            description,
            assigneeAgentId: executor?.agentId ?? null,
            priority: task.priority,
            projectId: task.projectId,
            goalId: task.goalId,
            billingCode: task.billingCode,
            parentId: task.id,
            originId: task.id,
            originFingerprint: fingerprint,
            idempotencyKey: `${REVIEW_REWORK_ORIGIN_KIND}:${task.id}:${decision.prKey}`,
          });
          if (!created) return false;
          reworkIssueId = created.id;
          reworkIdentifier = created.identifier;
          result.reworkCreated += 1;
          await deps.logActivity({
            companyId: task.companyId,
            action: REVIEW_REWORK_CREATED_ACTION,
            issueId: task.id,
            details: {
              reworkIssueId,
              prRef: decision.prRef,
              headSha: decision.headSha,
              executorAgentId: executor?.agentId ?? null,
              executorSource: executor?.source ?? "role_queue",
              verdictAt: decision.verdict.at,
              verdictCommentId: decision.verdict.commentId,
              verdictSource: decision.verdict.source,
            },
          });
          if (executor) {
            await wake(
              executor.agentId,
              reworkIssueId,
              "issue_assigned",
              "review_rework_create",
              `${REVIEW_REWORK_WAKE_IDEMPOTENCY_PREFIX}:assign:${reworkIssueId}`,
              { identifier: reworkIdentifier },
            );
          }
        } else {
          const reopened = await deps.store.reopenReworkTask({
            issueId: decision.child.id,
            companyId: task.companyId,
            originFingerprint: fingerprint,
            comment:
              `Reopened: a newer RETURN verdict on PR ${decision.prRef} (${decision.verdict.at}) needs` +
              (decision.headSha ? ` another pass; head \`${decision.headSha}\`.` : " another pass; the head is pinned on the next pass."),
          });
          if (!reopened) return false;
          reworkIssueId = decision.child.id;
          reworkIdentifier = decision.child.identifier;
          result.reworkReopened += 1;
          await deps.logActivity({
            companyId: task.companyId,
            action: REVIEW_REWORK_REOPENED_ACTION,
            issueId: task.id,
            details: { reworkIssueId, prRef: decision.prRef, headSha: decision.headSha, verdictAt: decision.verdict.at },
          });
          if (executor && !decision.child.assigneeAgentId) {
            await wake(
              executor.agentId,
              reworkIssueId,
              "issue_assigned",
              "review_rework_reopen",
              `${REVIEW_REWORK_WAKE_IDEMPOTENCY_PREFIX}:assign:${reworkIssueId}:${decision.verdict.at}`,
              { identifier: reworkIdentifier },
            );
          }
        }
        const blocked = await deps.store.blockReviewTask({
          issueId: task.id,
          companyId: task.companyId,
          expectStatus: task.status,
          reworkIssueId,
          comment:
            `Review blocked by the return loop: the RETURN verdict on PR ${decision.prRef} opened rework ` +
            `\`${reworkIdentifier ?? reworkIssueId}\`; this task is released and the reviewer woken when the` +
            ` PR head moves. Verdict: ${decision.verdict.source === "comment" ? `comment \`${decision.verdict.commentId}\`` : "GitHub review decision"} (${decision.verdict.at}).`,
        });
        if (blocked) {
          result.blocked += 1;
          await deps.logActivity({
            companyId: task.companyId,
            action: REVIEW_REWORK_BLOCKED_ACTION,
            issueId: task.id,
            details: { reworkIssueId, prRef: decision.prRef },
          });
        }
        return true;
      }
      case "ensure_blocked": {
        const blocked = await deps.store.blockReviewTask({
          issueId: task.id,
          companyId: task.companyId,
          expectStatus: task.status,
          reworkIssueId: decision.child.id,
          comment:
            "Review blocked again by the return loop: the rework task is still active, so the review waits" +
            ` on \`${decision.child.identifier ?? decision.child.id}\` until the PR head moves.`,
        });
        if (!blocked) return false;
        result.blocked += 1;
        return true;
      }
      case "record_baseline": {
        const stamped = await deps.store.stampReworkFingerprint({
          issueId: decision.child.id,
          companyId: task.companyId,
          originFingerprint: encodeReworkFingerprint(decision.prKey, decision.headSha),
        });
        if (!stamped) return false;
        result.baselinesRecorded += 1;
        return true;
      }
      case "unblock_review": {
        const from = decision.previousHeadSha ? `\`${decision.previousHeadSha}\`` : "an unrecorded head";
        const unblocked = await deps.store.unblockReviewTask({
          issueId: task.id,
          companyId: task.companyId,
          reworkIssueId: decision.child.id,
          comment:
            `Head moved on PR ${decision.prRef}: ${from} -> \`${decision.headSha}\`. The review task is` +
            ` released to todo by the return loop (rework \`${decision.child.identifier ?? decision.child.id}\`);` +
            ` the reviewer is woken. ${REVIEW_REWORK_HEAD_ACK_MARKER} ${decision.prKey}: ${decision.headSha}`,
        });
        if (!unblocked) return false;
        result.unblocked += 1;
        await deps.logActivity({
          companyId: task.companyId,
          action: REVIEW_REWORK_UNBLOCKED_ACTION,
          issueId: task.id,
          details: {
            prRef: decision.prRef,
            previousHeadSha: decision.previousHeadSha,
            headSha: decision.headSha,
            reworkIssueId: decision.child.id,
          },
        });
        const reviewerId = task.assigneeAgentId;
        if (reviewerId) {
          await wake(
            reviewerId,
            task.id,
            REVIEW_REWORK_WAKE_REASON,
            "review_rework_head_moved",
            `${REVIEW_REWORK_WAKE_IDEMPOTENCY_PREFIX}:head:${task.id}:${decision.headSha}`,
            { identifier: task.identifier, prRef: decision.prRef, headSha: decision.headSha },
          );
        }
        return true;
      }
      default: {
        void prs;
        return false;
      }
    }
  }

  return {
    resetForTest() {
      lastSweepAtMs = 0;
    },
    async sweep(now = (deps.now ?? (() => new Date()))(), options) {
      const result: ReviewReworkSweepResult = {
        skippedPass: false,
        scanned: 0,
        reworkCreated: 0,
        reworkReopened: 0,
        blocked: 0,
        unblocked: 0,
        closed: 0,
        baselinesRecorded: 0,
        failed: 0,
      };
      if (!options?.force && now.getTime() - lastSweepAtMs < intervalMs) {
        result.skippedPass = true;
        return result;
      }
      lastSweepAtMs = now.getTime();
      if (deps.isUnderMaintenance && (await deps.isUnderMaintenance())) {
        result.skippedPass = true;
        return result;
      }
      const settings = await deps.readSettings();
      if (!settings.enabled) return result;
      const moves = { count: 0 };
      const companyIds = await deps.store.listActiveCompanyIds();
      for (const companyId of companyIds) {
        try {
          await sweepCompany(companyId, settings, now, result, moves);
        } catch (err) {
          result.failed += 1;
          log.warn({ err, companyId }, "review rework sweep failed for one company");
        }
      }
      return result;
    },
  };
}
