// myrmidon(OPE-11767): the board merges an approved pull request itself.
//
// The gap this closes. The board approved a PR (its own review stage), but CI
// was still running; when CI turned green nothing merged it — the steward lane
// of the sweep only creates a human "Merge PR" task (and on the release board
// its resolver has no token, see github-board-merge.ts), and a conflict after
// the approval left the task in `in_review` forever. A host script used to
// cover the gap; it was removed.
//
// The rule. A task whose review stage is approved (the stage is completed and
// its last decision is `approved`) and whose open pull request satisfies ALL
// of these is merged by the board through the shared GitHub App identity:
//   - the base branch is one of `boardMerge.baseBranches` (main);
//   - the approving verdict names the CURRENT head — an approval is bound to
//     the exact head and never carried over to a new one;
//   - every `boardMerge.requiredChecks` check (the `CI result` run, latest run
//     per name) is `success` on that head;
//   - GitHub reports the PR mergeable as it stands (clean / unstable /
//     has_hooks). A branch that is merely behind main is merged as it is:
//     `update-branch` would move the head and void the approval, so the board
//     never does that after an approval. GitHub reports `behind` only when the
//     repository requires an up-to-date branch — then the task goes back to
//     its implementer to rebase, exactly like a conflict.
// The merge call carries the approved head sha, so a head that moved after it
// was read is refused by GitHub itself (409) — a commit nobody reviewed cannot
// be merged. A conflict (or a required-up-to-date PR that is behind) after the
// approval returns the task to its implementer once, with a system comment.
//
// Triggers. Event-driven: a review approval (`review_approved`) and a CI run
// completion (`ci_completed`) announce themselves through merge-trigger.ts and
// evaluate the one task / pull request at once. The periodic review-routing
// sweep calls `sweepCompany` as the safety net, with a per-pass cap on merges.
// There is no loop of its own: the sweep tick is the only clock.
//
// Idempotence. A PR is evaluated by one caller at a time (an in-process
// in-flight set per pull request); a merged PR is closed, so the next read
// skips it; a second merge call for the same head would be refused by GitHub;
// the return to the implementer is guarded by the approval still standing
// under the row lock; refused / failed / skipped pull requests rest for a
// cool-down before the sweep looks again (an event bypasses it: it carries
// new information).

import type { Logger } from "pino";
import {
  REVIEW_ROUTING_APPROVED_LABEL,
  REVIEW_ROUTING_BOARD_MERGED_ACTION,
  REVIEW_ROUTING_BOARD_MERGE_BLOCKED_ACTION,
  REVIEW_ROUTING_BOARD_MERGE_LABELED_ACTION,
  REVIEW_ROUTING_BOARD_MERGE_REFUSED_ACTION,
  REVIEW_ROUTING_BOARD_MERGE_RETURNED_ACTION,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type ReviewRoutingSettings,
} from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import type { BoardMergeClient } from "./github-board-merge.js";
import {
  decideBoardMerge,
  pullRequiresFullCi,
  requiredChecksForPull,
  BOARD_MERGE_FULL_CI_LABEL,
  type BoardMergeReturnReason,
} from "./pr-policy.js";
import type { ApprovedPrIssueRow, ReviewRoutingStore } from "./store.js";

export interface BoardMergeDeps {
  store: Pick<ReviewRoutingStore, "listApprovedPrIssues" | "returnApprovedPrToImplementer">;
  client: BoardMergeClient;
  addComment: (
    issueId: string,
    body: string,
    options: { presentation: IssueCommentPresentation; metadata: IssueCommentMetadata },
  ) => Promise<unknown>;
  /** Wakes an agent on a task (the implementer of a returned task). */
  wakeAgent: (
    agentId: string,
    wake: { issueId: string; reason: string; mutation: string; executionStage: Record<string, unknown> },
  ) => Promise<unknown>;
  logActivity: (input: {
    companyId: string;
    action: string;
    issueId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  now?: () => Date;
  log?: Pick<Logger, "info" | "warn">;
}

export interface BoardMergePassResult {
  /** Approved pull requests read from GitHub in this call. */
  evaluated: number;
  merged: number;
  returned: number;
  labeled: number;
  /** Approved heads that are not mergeable yet (CI running, mergeability not computed, blocked). */
  waiting: number;
  failed: number;
}

export interface BoardMerger {
  /** The periodic safety net: every approved task of the company, capped by `boardMerge.maxMergesPerPass`. */
  sweepCompany(companyId: string, settings: ReviewRoutingSettings, now?: Date): Promise<BoardMergePassResult>;
  /** The event path of a review approval: one task. */
  mergeIssue(companyId: string, issueId: string, settings: ReviewRoutingSettings, now?: Date): Promise<BoardMergePassResult>;
  /** The event path of a completed CI run: one pull request. */
  mergePullRequest(
    companyId: string,
    pullRequest: { repository: string; number: number },
    settings: ReviewRoutingSettings,
    now?: Date,
  ): Promise<BoardMergePassResult>;
  resetForTest(): void;
}

/** How long the sweep leaves a refused / failed / skipped pull request alone. */
export const BOARD_MERGE_COOLDOWN_MS = 2 * 60 * 1000;
/** After GitHub refused the merge (required checks, protection): the next look is later. */
export const BOARD_MERGE_REFUSED_COOLDOWN_MS = 5 * 60 * 1000;
/** A repository the board has no write identity for is not asked again for this long. */
export const BOARD_MERGE_NO_IDENTITY_COOLDOWN_MS = 10 * 60 * 1000;
/** A merged pull request is closed; the sweep does not even read it again for this long. */
export const BOARD_MERGE_DONE_COOLDOWN_MS = 10 * 60 * 1000;
const WARN_THROTTLE_MS = 60 * 60 * 1000;
/** Approved pull requests read per sweep pass. */
export const BOARD_MERGE_PAGE_SIZE = 100;

function notice(title: string, tone: "info" | "warning" = "info"): IssueCommentPresentation {
  return { kind: "system_notice", tone, title, detailsDefaultOpen: false };
}

function metadataFor(rows: Record<string, string>): IssueCommentMetadata {
  return {
    version: 1,
    sections: [
      {
        title: "Board merge",
        rows: Object.entries(rows).map(([label, value]) => ({ type: "key_value" as const, label, value })),
      },
    ],
  };
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** The system comment of a task sent back for a rebase: Russian first (the owner's language), English second. */
export function boardMergeReturnComment(input: {
  reason: BoardMergeReturnReason;
  repository: string;
  number: number;
  headSha: string;
  baseRef: string;
}): string {
  const subject = `PR ${input.repository}#${input.number} (${shortSha(input.headSha)})`;
  if (input.reason === "head_moved") {
    return (
      `Голова сменилась после одобрения. ${subject}: одобрение ревьюера относится к прежней голове, текущую оно не покрывает, ` +
      "поэтому доска PR не сливает. Проверь, что в ветке только нужные изменения (если просто подтянут main — менять нечего), и верни задачу на ревью: " +
      "ревьюер одобрит текущую голову, после чего доска сольёт PR.\n\n" +
      `The head moved after approval. ${subject}: the reviewer's approval covers the previous head, not the current one, ` +
      "so the board does not merge. Check the branch holds only the intended changes (if main was merged in, nothing to change) and resubmit for review."
    );
  }
  if (input.reason === "conflict") {
    return (
      `Конфликт с ${input.baseRef} после одобрения — нужен rebase. ${subject} не сливается: GitHub сообщает конфликт. ` +
      `Сделай rebase на актуальный ${input.baseRef}, запушь и верни задачу на ревью: одобрение относится к прежней голове и новую не покрывает.\n\n` +
      `Conflict with ${input.baseRef} after approval — a rebase is needed. ${subject} cannot be merged. ` +
      "Rebase onto the current base, push, and resubmit for review: the approval covered the previous head, not the new one."
    );
  }
  return (
    `Ветка отстала от ${input.baseRef} после одобрения — нужен rebase. ${subject}: репозиторий требует актуальной ветки перед слиянием, ` +
    "а доска не обновляет ветку сама (это сменило бы голову и обнулило одобрение). Сделай rebase, запушь и верни задачу на ревью.\n\n" +
    `The branch is behind ${input.baseRef} after approval — a rebase is needed. ${subject}: the repository requires an up-to-date ` +
    "branch before merging, and the board does not update it itself (that would move the head and void the approval). " +
    "Rebase, push, and resubmit for review."
  );
}

function emptyResult(): BoardMergePassResult {
  return { evaluated: 0, merged: 0, returned: 0, labeled: 0, waiting: 0, failed: 0 };
}

interface PassContext {
  /** Merges this call may still perform. */
  mergesLeft: number;
  /** Events carry new information: they bypass the cool-down of the sweep. */
  ignoreCooldown: boolean;
  /** GitHub's budget is gone: nothing more is asked in this call. */
  stop: boolean;
}

export function createBoardMerger(deps: BoardMergeDeps): BoardMerger {
  const nowFn = deps.now ?? (() => new Date());
  const log = deps.log ?? logger;
  /** One evaluator per pull request at a time (sweep and events never merge the same PR twice). */
  const inFlight = new Set<string>();
  /** key -> epoch ms before which the sweep leaves the pull request alone. */
  const notBefore = new Map<string, number>();
  const warned = new Map<string, number>();
  /**
   * myrmidon(OPE-13136): pull request key -> when this head was first seen BLOCKED with the review
   * marker present and the required checks green. `alerted` keeps the one alert per head.
   */
  const blockedSince = new Map<string, { headSha: string; since: number; seen: number; alerted: boolean }>();

  /** True when this key may speak now (once per throttle window); marks it as spoken. */
  function throttleOpen(key: string, now: Date): boolean {
    const last = warned.get(key) ?? 0;
    if (now.getTime() - last < WARN_THROTTLE_MS) return false;
    warned.set(key, now.getTime());
    return true;
  }

  function warnThrottled(key: string, now: Date, fields: Record<string, unknown>, message: string) {
    if (!throttleOpen(key, now)) return;
    log.warn(fields, message);
  }

  function rest(key: string, now: Date, ms: number) {
    notBefore.set(key, now.getTime() + ms);
  }

  async function safely(label: string, fields: Record<string, unknown>, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (err) {
      log.warn({ err, ...fields }, `board merge: ${label} failed after the change was committed`);
    }
  }

  /** myrmidon(OPE-13136): one activity record and one warning per head that stays BLOCKED past the threshold. */
  async function noteBlocked(
    companyId: string,
    row: ApprovedPrIssueRow,
    key: string,
    headSha: string,
    requiredChecks: readonly string[],
    afterMinutes: number,
    now: Date,
  ): Promise<void> {
    let entry = blockedSince.get(key);
    if (!entry || entry.headSha !== headSha) {
      entry = { headSha, since: now.getTime(), seen: now.getTime(), alerted: false };
      blockedSince.set(key, entry);
    }
    entry.seen = now.getTime();
    if (afterMinutes <= 0 || entry.alerted) return;
    const minutes = Math.floor((now.getTime() - entry.since) / 60_000);
    if (minutes < afterMinutes) return;
    entry.alerted = true;
    const pr = `${row.repository}#${row.number}`;
    const text = "GitHub reports the pull request BLOCKED although the required checks are green";
    log.warn({ pr, headSha, minutesBlocked: minutes, requiredChecks }, `board merge: ${text}`);
    await safely("activity", { pr }, () =>
      deps.logActivity({
        companyId,
        action: REVIEW_ROUTING_BOARD_MERGE_BLOCKED_ACTION,
        issueId: row.issueId,
        details: {
          repository: row.repository,
          pullRequest: row.number,
          headSha,
          minutesBlocked: minutes,
          requiredChecks,
          message: text,
        },
      }),
    );
  }

  async function evaluate(
    companyId: string,
    row: ApprovedPrIssueRow,
    settings: ReviewRoutingSettings,
    now: Date,
    ctx: PassContext,
    result: BoardMergePassResult,
  ): Promise<void> {
    const merge = settings.boardMerge;
    const pr = `${row.repository}#${row.number}`;
    if (
      merge.repositories.length > 0 &&
      !merge.repositories.some((entry) => entry.toLowerCase() === row.repository.toLowerCase())
    ) {
      return;
    }
    const key = `${companyId}|${pr.toLowerCase()}`;
    if (inFlight.has(key)) return;
    if (!ctx.ignoreCooldown && (notBefore.get(key) ?? 0) > now.getTime()) return;
    inFlight.add(key);
    try {
      const pull = await deps.client.readPull({ companyId, repository: row.repository, number: row.number });
      if (!pull.ok) {
        if (pull.reason === "rate_limited") {
          ctx.stop = true;
        } else if (pull.reason === "no_token") {
          rest(key, now, BOARD_MERGE_NO_IDENTITY_COOLDOWN_MS);
        } else {
          result.failed += 1;
          rest(key, now, BOARD_MERGE_COOLDOWN_MS);
          warnThrottled(`read:${key}:${pull.reason}`, now, { pr, reason: pull.reason }, "board merge: reading the pull request failed");
        }
        return;
      }
      result.evaluated += 1;
      const facts = pull.facts;

      let files: readonly string[] | null = null;
      if (deps.client.readPullFiles) {
        const filesResult = await deps.client.readPullFiles({
          companyId,
          repository: row.repository,
          number: row.number,
        });
        if (!filesResult.ok) {
          if (filesResult.reason === "rate_limited") {
            ctx.stop = true;
          } else {
            result.failed += 1;
            rest(key, now, BOARD_MERGE_COOLDOWN_MS);
            warnThrottled(`files:${key}:${filesResult.reason}`, now, { pr, reason: filesResult.reason }, "board merge: reading pull request files failed");
          }
          return;
        }
        files = filesResult.files;
      }

      const effectiveRequiredChecks = requiredChecksForPull({
        defaultChecks: merge.requiredChecks,
        files,
        labels: facts.labels,
      });

      const decide = (checks: Parameters<typeof decideBoardMerge>[0]["checks"]) =>
        decideBoardMerge({
          facts,
          baseBranches: merge.baseBranches,
          verdict: row.verdict,
          checks,
          requiredChecks: effectiveRequiredChecks,
          approvedLabel: REVIEW_ROUTING_APPROVED_LABEL,
          files,
        });

      let decision = decide(null);
      if (decision.kind === "read_checks") {
        const checks = await deps.client.readChecks({
          companyId,
          repository: row.repository,
          headSha: facts.headSha!,
          names: effectiveRequiredChecks,
        });
        if (!checks.ok) {
          if (checks.reason === "rate_limited") {
            ctx.stop = true;
          } else {
            result.failed += 1;
            rest(key, now, BOARD_MERGE_COOLDOWN_MS);
            warnThrottled(`checks:${key}:${checks.reason}`, now, { pr, reason: checks.reason }, "board merge: reading the required checks failed");
          }
          return;
        }
        decision = decide(checks.checks);
      }

      const headSha = facts.headSha ?? "";
      const final = decision;
      // myrmidon(OPE-13136): any state but "blocked with the marker present" ends the blocked spell.
      if (!(final.kind === "wait" && final.reason === "blocked")) blockedSince.delete(key);
      switch (final.kind) {
        case "skip":
          rest(key, now, BOARD_MERGE_COOLDOWN_MS);
          return;

        case "wait":
          // myrmidon(OPE-13136): `wait/blocked` means the marker is on, the required checks are green
          // and GitHub still says BLOCKED (a required check left "expected", a protection rule).
          // Nothing else tells anyone: count the time and alert once per head.
          if (final.reason === "blocked") {
            await noteBlocked(companyId, row, key, headSha, effectiveRequiredChecks, merge.blockedAlertAfterMinutes, now);
          }
          result.waiting += 1;
          return;

        case "read_checks":
        case "read_files":
          result.waiting += 1;
          return;

        case "label": {
          const labelToApply = final.label ?? REVIEW_ROUTING_APPROVED_LABEL;
          const labeled = await deps.client.addApprovedLabel({
            companyId,
            repository: row.repository,
            number: row.number,
            label: labelToApply,
          });
          // The gate that reads the label is a workflow run: look again after it had time to start.
          rest(key, now, BOARD_MERGE_COOLDOWN_MS);
          if (!labeled) {
            result.failed += 1;
            warnThrottled(`label:${key}`, now, { pr, label: labelToApply }, "board merge: could not put the label on the pull request");
            return;
          }
          result.labeled += 1;
          await safely("activity", { pr }, () =>
            deps.logActivity({
              companyId,
              action: REVIEW_ROUTING_BOARD_MERGE_LABELED_ACTION,
              issueId: row.issueId,
              details: { repository: row.repository, pullRequest: row.number, headSha, label: labelToApply },
            }),
          );
          return;
        }

        case "return": {
          const returned = await deps.store.returnApprovedPrToImplementer({ companyId, issueId: row.issueId, at: now });
          rest(key, now, BOARD_MERGE_COOLDOWN_MS);
          if (!returned) return; // the approval no longer stands, or the task was already sent back
          result.returned += 1;
          const baseRef = facts.baseRef ?? "main";
          await safely("comment", { pr }, () =>
            deps.addComment(
              row.issueId,
              boardMergeReturnComment({ reason: final.reason, repository: row.repository, number: row.number, headSha, baseRef }),
              {
                presentation: notice("Rebase needed after approval", "warning"),
                metadata: metadataFor({
                  "Pull request": pr,
                  Head: headSha,
                  Reason:
                    final.reason === "conflict"
                      ? `conflict with ${baseRef}`
                      : final.reason === "head_moved"
                        ? "head moved after approval"
                        : `behind ${baseRef}`,
                  "Returned to": returned.implementerAgentId,
                }),
              },
            ),
          );
          await safely("activity", { pr }, () =>
            deps.logActivity({
              companyId,
              action: REVIEW_ROUTING_BOARD_MERGE_RETURNED_ACTION,
              issueId: row.issueId,
              details: {
                repository: row.repository,
                pullRequest: row.number,
                headSha,
                reason: final.reason,
                returnedTo: returned.implementerAgentId,
                previousStatus: returned.previousStatus,
              },
            }),
          );
          await safely("wake", { pr }, () =>
            deps.wakeAgent(returned.implementerAgentId, {
              issueId: row.issueId,
              reason: "execution_changes_requested",
              mutation: "myrmidon_board_merge_return",
              executionStage: {
                wakeRole: "executor",
                stageId: returned.executionState.currentStageId ?? null,
                stageType: returned.executionState.currentStageType ?? null,
                currentParticipant: returned.executionState.currentParticipant ?? null,
                returnAssignee: returned.executionState.returnAssignee ?? null,
                reviewRequest: null,
                lastDecisionOutcome: "changes_requested",
                allowedActions: ["address_changes", "resubmit"],
              },
            }),
          );
          return;
        }

        case "merge": {
          if (ctx.mergesLeft <= 0) {
            result.waiting += 1; // the per-pass cap: this one goes first on the next pass
            return;
          }
          const outcome = await deps.client.merge({
            companyId,
            repository: row.repository,
            number: row.number,
            headSha,
            method: merge.method,
          });
          if (outcome.status === "head_moved") {
            result.waiting += 1; // GitHub refused a commit the verdict does not cover; the next read sees the new head
            return;
          }
          if (outcome.status === "refused") {
            result.waiting += 1;
            rest(key, now, BOARD_MERGE_REFUSED_COOLDOWN_MS);
            const message = outcome.message ?? null;
            log.info({ pr, httpStatus: outcome.httpStatus, message }, "board merge: GitHub does not merge the pull request as it stands");
            // myrmidon(OPE-13136): GitHub's refusal text is the only clue, put it on the task (throttled like the warning).
            if (throttleOpen(`refused:${key}`, now)) {
              await safely("activity", { pr }, () =>
                deps.logActivity({
                  companyId,
                  action: REVIEW_ROUTING_BOARD_MERGE_REFUSED_ACTION,
                  issueId: row.issueId,
                  details: {
                    repository: row.repository,
                    pullRequest: row.number,
                    headSha,
                    httpStatus: outcome.httpStatus,
                    message,
                  },
                }),
              );
            }
            return;
          }
          if (outcome.status === "failed") {
            if (outcome.reason === "rate_limited") ctx.stop = true;
            result.failed += 1;
            rest(key, now, BOARD_MERGE_COOLDOWN_MS);
            warnThrottled(`merge:${key}:${outcome.reason}`, now, { pr, reason: outcome.reason }, "board merge: the merge call failed");
            return;
          }
          ctx.mergesLeft -= 1;
          result.merged += 1;
          rest(key, now, BOARD_MERGE_DONE_COOLDOWN_MS);
          log.info({ pr, headSha, method: merge.method, mergeCommitSha: outcome.sha }, "board merge: merged an approved pull request");
          await safely("comment", { pr }, () =>
            deps.addComment(
              row.issueId,
              `Automatic merge: ${pr} was merged by the board (${merge.method}). The review stage approved head ${shortSha(headSha)} ` +
                `and ${merge.requiredChecks.map((name) => `\`${name}\``).join(", ")} is green on it. ` +
                "The task closes when the pull request sync sees the merge.",
              {
                presentation: notice("Pull request merged"),
                metadata: metadataFor({
                  "Pull request": pr,
                  Head: headSha,
                  Method: merge.method,
                  "Merge commit": outcome.sha ?? "(not reported)",
                }),
              },
            ),
          );
          await safely("activity", { pr }, () =>
            deps.logActivity({
              companyId,
              action: REVIEW_ROUTING_BOARD_MERGED_ACTION,
              issueId: row.issueId,
              details: {
                repository: row.repository,
                pullRequest: row.number,
                headSha,
                method: merge.method,
                mergeCommitSha: outcome.sha,
                requiredChecks: merge.requiredChecks,
              },
            }),
          );
          return;
        }
      }
    } finally {
      inFlight.delete(key);
    }
  }

  async function run(
    companyId: string,
    rows: readonly ApprovedPrIssueRow[],
    settings: ReviewRoutingSettings,
    now: Date,
    ignoreCooldown: boolean,
  ): Promise<BoardMergePassResult> {
    const result = emptyResult();
    // Resting entries that ran out are dropped, so the maps hold only what is still waiting.
    for (const [key, until] of notBefore) if (until <= now.getTime()) notBefore.delete(key);
    for (const [key, at] of warned) if (now.getTime() - at >= WARN_THROTTLE_MS) warned.delete(key);
    // myrmidon(OPE-13136): a blocked spell of a PR nobody has looked at for a day is gone (merged, closed, unapproved).
    for (const [key, entry] of blockedSince) if (now.getTime() - entry.seen >= 24 * 60 * 60 * 1000) blockedSince.delete(key);
    const ctx: PassContext = { mergesLeft: settings.boardMerge.maxMergesPerPass, ignoreCooldown, stop: false };
    for (const row of rows) {
      if (ctx.stop) break;
      try {
        await evaluate(companyId, row, settings, now, ctx, result);
      } catch (err) {
        result.failed += 1;
        log.warn({ err, issueId: row.issueId, pr: `${row.repository}#${row.number}` }, "board merge: evaluating an approved pull request failed");
      }
    }
    return result;
  }

  function enabled(settings: ReviewRoutingSettings): boolean {
    return settings.enabled && settings.boardMerge.enabled;
  }

  return {
    resetForTest() {
      inFlight.clear();
      notBefore.clear();
      warned.clear();
      blockedSince.clear();
    },

    async sweepCompany(companyId, settings, now = nowFn()) {
      if (!enabled(settings)) return emptyResult();
      const rows = await deps.store.listApprovedPrIssues(companyId, { limit: BOARD_MERGE_PAGE_SIZE });
      return run(companyId, rows, settings, now, false);
    },

    async mergeIssue(companyId, issueId, settings, now = nowFn()) {
      if (!enabled(settings)) return emptyResult();
      const rows = await deps.store.listApprovedPrIssues(companyId, { issueId, limit: BOARD_MERGE_PAGE_SIZE });
      return run(companyId, rows, settings, now, true);
    },

    async mergePullRequest(companyId, pullRequest, settings, now = nowFn()) {
      if (!enabled(settings)) return emptyResult();
      const rows = (await deps.store.listApprovedPrIssues(companyId, { limit: BOARD_MERGE_PAGE_SIZE })).filter(
        (row) => row.number === pullRequest.number && row.repository.toLowerCase() === pullRequest.repository.toLowerCase(),
      );
      return run(companyId, rows, settings, now, true);
    },
  };
}
