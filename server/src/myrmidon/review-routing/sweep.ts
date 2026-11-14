// myrmidon(REVIEW-ROUTING): the periodic review routing.
//
// One pass per interval, per company, with the settings read fresh on every
// pass (so a change applies without a restart):
//
//  1. a task in `in_review` with no reviewer gets a one-stage review with the
//     least-loaded eligible reviewer (reviewer roles, below the load ceiling,
//     never the task's author or assignee); the choice is written as a system
//     comment and an activity entry, and the reviewer is woken. Every pool of
//     this routing (assign, reassign, rebalance, PR lane) holds only
//     queue-eligible reviewers of the task's own agent group (OPE-12683): an
//     empty own group raises the signal or does nothing, it never widens;
//  2. when no reviewer is eligible the task is signalled on the attention desk
//     (`no_reviewer`) instead of staying silent;
//  3. a review this routing started that has had no verdict for
//     `reassignAfterHours` is signalled (`review_overdue`) and moved to another
//     reviewer (never one that already had it); with no other reviewer the
//     signal is what remains.
//
// The 1.6.5 PR lane runs after the task lane on the same pass but on its own
// `pollIntervalSec` throttle, per company:
//
//  4. open pull requests (from the webhook-fed externalObjects rows, plus a
//     repo poll of the configured/known repositories) whose CURRENT head is
//     green with no review verdict get a `Review PR …` task with the
//     least-loaded reviewer (both load gates, never the PR author's linked
//     agent); an approved green head gets a `Merge PR …` steward task that
//     lands the PR through update-branch: refresh the head onto the base,
//     wait for green CI on the refreshed head, then merge (1.6.5
//     UPDATE-BRANCH-STEWARD);
//  5. a routed task whose recorded head no longer matches the PR's current
//     head is superseded: cancelled with one system comment naming the new
//     head;
//  6. with no eligible reviewer/steward the PR raises a `no_reviewer` /
//     `no_steward` attention card carrying its coordinates.
//
// myrmidon(OPE-11767): the last step of the pass is the board-side merge
// (board-merge.ts). A task whose review stage is approved and whose pull
// request is green and mergeable on the approved head is merged by the board
// itself through the shared GitHub App identity; a conflict after the approval
// sends the task back to its implementer. The same evaluation also runs the
// moment a review is approved or a CI run completes (`mergeOnEvent`, fed by
// merge-trigger.ts); this pass is the safety net with a per-pass merge cap.
//
// The sweep is idempotent: the assignment re-checks its premise under a row
// lock, so a second pass (or a racing human) never double-assigns. The PR lane
// re-checks the work-product coverage inside its guarded create path, and a
// GitHub read failure creates and closes nothing.

import type { Logger } from "pino";
import {
  REVIEW_ROUTING_ASSIGNED_ACTION,
  REVIEW_ROUTING_PR_TASK_CREATED_ACTION,
  REVIEW_ROUTING_REASSIGNED_ACTION,
  REVIEW_ROUTING_STEWARD_TASK_CREATED_ACTION,
  REVIEW_ROUTING_WAKE_ACTION,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type ReviewRoutingSettings,
} from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import { prSignalSubjectId, replaceReviewRoutingSignals, type ReviewRoutingSignal } from "./attention.js";
import {
  asRecord,
  buildPrRoutingTaskPatch,
  buildReviewRoutingAssignPatch,
  buildReviewRoutingReassignPatch,
  buildReviewRoutingWakeContext,
  excludedReviewerIds,
  hoursSince,
  isEscalatedReviewStage,
  isReviewOverdue,
  issueAnchorAgentId,
  issueNeedsReviewer,
  minutesSince,
  ownGroupReviewerPool,
  pickPrReviewer,
  pickReviewer,
  readPendingAgentReview,
  resolveAgentGroupKey,
  type ReviewerCandidate,
  type RoutingIssue,
} from "./policy.js";
import {
  prRoutingCoverageKey,
  prReviewTaskTitle,
  prRoutingTaskDescription,
  prStewardTaskTitle,
  prTaskIsSuperseded,
  reviewTaskDueForHead,
  stewardTaskDueForHead,
  shouldRouteOpenPrToReview,
} from "./pr-policy.js";
import type { PullRequestHeadResolver } from "./github.js";
import { createBoardMerger, type BoardMergePassResult } from "./board-merge.js";
import type { BoardMergeClient } from "./github-board-merge.js";
import type { BoardMergeTriggerEvent } from "./merge-trigger.js";
import type { InReviewIssueRow, ReviewRoutingStore } from "./store.js";
import { REVIEW_ROUTING_MAX_WAKES_PER_PASS, REVIEW_WAKE_MAX_ATTEMPTS, REVIEW_WAKE_MAX_BACKOFF_MS, REVIEW_WAKE_REARM_AFTER_MS, REVIEW_WAKE_RETRY_BACKOFF_MS, REVIEW_WAKE_STALE_AFTER_MS, REVIEW_ROUTING_MAX_MOVES_PER_PASS } from "./sweep-constants.js";
export { REVIEW_ROUTING_MAX_WAKES_PER_PASS, REVIEW_WAKE_MAX_ATTEMPTS, REVIEW_WAKE_MAX_BACKOFF_MS, REVIEW_WAKE_REARM_AFTER_MS, REVIEW_WAKE_RETRY_BACKOFF_MS, REVIEW_WAKE_STALE_AFTER_MS, REVIEW_ROUTING_MAX_MOVES_PER_PASS } from "./sweep-constants.js";
import type { PrRoutedTask } from "./pr-policy.js";

export const DEFAULT_REVIEW_ROUTING_SWEEP_INTERVAL_SEC = 60;
/** Tasks inspected per company per pass (oldest update first). */
export const REVIEW_ROUTING_PAGE_SIZE = 200;

/** True when some non-excluded pool member has strictly lower load than the current reviewer. */
export function poolHasLessLoadedAlternative(
  current: { id: string; load: number },
  pool: readonly ReviewerCandidate[],
  excluded: ReadonlySet<string>,
): boolean {
  return pool.some(
    (candidate) => candidate.id !== current.id && !excluded.has(candidate.id) && candidate.load < current.load,
  );
}

function routedReviewerIds(
  history: ReadonlyMap<string, { lastAt: Date; reviewerAgentIds: string[] }>,
  issueId: string,
): string[] {
  return history.get(issueId)?.reviewerAgentIds ?? [];
}
/** PR candidates inspected per company per pass. */
export const REVIEW_ROUTING_PR_PAGE_SIZE = 100;
/** How long the card of a completed reassignment stays on the desk. */
export const REVIEW_ROUTING_REASSIGN_SIGNAL_TTL_MS = 24 * 60 * 60 * 1000;
export const REVIEW_ROUTING_ACTOR_ID = "review_routing_sweep";

export interface ReviewRoutingSweepResult {
  skippedPass: boolean;
  scanned: number;
  assigned: number;
  reassigned: number;
  /** Tasks signalled (no reviewer, or overdue) in this pass. */
  signaled: number;
  /** Targeted wakeups issued for stale reviewer stages. */
  woken: number;
  failed: number;
  // --- PR lane (1.6.5, additive) ---------------------------------------------
  /** Open PR candidates this pass looked at. */
  prScanned: number;
  /** Review tasks created for green verdict-less heads. */
  prTasksCreated: number;
  /** Merge-steward tasks created for approved green heads. */
  stewardTasksCreated: number;
  /** Routed tasks cancelled because the PR head moved on. */
  prSuperseded: number;
  /** Pull request review approvals propagated natively to GitHub. */
  prApprovalsPropagated: number;
  // --- Board-side merge (OPE-11767) ------------------------------------------
  /** Approved pull requests the board merged in this pass. */
  boardMerged: number;
  /** Approved tasks sent back to their implementer (conflict / behind main). */
  boardReturned: number;
}

export interface ReviewRoutingSweepDeps {
  store: ReviewRoutingStore;
  readSettings: () => Promise<ReviewRoutingSettings>;
  /** GitHub head resolver; without it the PR lane stays inert (task lane only). */
  prResolver?: PullRequestHeadResolver;
  /**
   * GitHub client of the board-side merge (OPE-11767). Without it the merge
   * step stays inert; with it, `boardMerge.enabled` (default on) decides.
   */
  boardMerge?: BoardMergeClient;
  /** PR approval propagator (propagates board review approvals to GitHub PR). */
  approvalPropagator?: (input: {
    companyId: string;
    repository: string;
    number: number;
    headSha: string;
    reviewedHeadSha?: string | null;
  }) => Promise<{ success: boolean; action?: string }>;
  addComment: (
    issueId: string,
    body: string,
    options: { presentation: IssueCommentPresentation; metadata: IssueCommentMetadata },
  ) => Promise<unknown>;
  wakeReviewer: (
    agentId: string,
    wake: { issueId: string; reason: string; mutation: string; executionStage: Record<string, unknown>; retryAttempt?: number },
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

export interface ReviewRoutingSweep {
  sweep(now?: Date, options?: { force?: boolean }): Promise<ReviewRoutingSweepResult>;
  /**
   * The event path of the board-side merge: a review was approved or a CI run
   * completed. Evaluates that one task / pull request at once; null when the
   * merge is not wired, the instance is under maintenance, or the event names
   * nothing to evaluate.
   */
  mergeOnEvent(event: BoardMergeTriggerEvent): Promise<BoardMergePassResult | null>;
  resetForTest(): void;
}

function notice(title: string): IssueCommentPresentation {
  return { kind: "system_notice", tone: "info", title, detailsDefaultOpen: false };
}

function metadataFor(rows: Record<string, string>): IssueCommentMetadata {
  return {
    version: 1,
    sections: [
      {
        title: "Review routing",
        rows: Object.entries(rows).map(([label, value]) => ({ type: "key_value" as const, label, value })),
      },
    ],
  };
}

export function createReviewRoutingSweep(deps: ReviewRoutingSweepDeps): ReviewRoutingSweep {
  const intervalMs = deps.intervalMs ?? DEFAULT_REVIEW_ROUTING_SWEEP_INTERVAL_SEC * 1000;
  const log = deps.log ?? logger;
  let lastSweepAtMs = 0;
  let lastPrLaneAtMs = 0;
  /** Cards of completed reassignments, kept for a day so the desk shows them. */
  const recentReassignments = new Map<string, { signal: ReviewRoutingSignal; untilMs: number }>();
  /** PR-lane signals from the lane's last actual run, kept through throttle gaps. */
  const prLaneSignalsByCompany = new Map<string, ReviewRoutingSignal[]>();
  const boardMerger = deps.boardMerge
    ? createBoardMerger({
        store: deps.store,
        client: deps.boardMerge,
        addComment: deps.addComment,
        wakeAgent: (agentId, wake) => deps.wakeReviewer(agentId, wake),
        logActivity: deps.logActivity,
        now: deps.now,
        log,
      })
    : null;

  async function sweepCompany(
    companyId: string,
    settings: ReviewRoutingSettings,
    now: Date,
    result: ReviewRoutingSweepResult,
  ): Promise<ReviewRoutingSignal[]> {
    const rows = await deps.store.listInReviewIssues(companyId, REVIEW_ROUTING_PAGE_SIZE);
    for (const row of rows) {
      row.reviewPathRecoveryEligible = issueNeedsReviewer(row);
      row.reviewRecoveryNow = now;
      row.reviewRecoveryUpdatedAt = row.updatedAt;
    }
    result.scanned += rows.length;

    const rowById = new Map(rows.map((row) => [row.id, row] as const));
    const needing = rows.filter(
      (row) => row.reviewPathRecoveryEligible && issueNeedsReviewer(row),
    );
    const pending = rows
      .map((row) => ({ row, review: readPendingAgentReview(row) }))
      .filter((entry): entry is { row: InReviewIssueRow; review: NonNullable<typeof entry.review> } => entry.review !== null);
    if (needing.length === 0 && pending.length === 0) {
      return liveReassignmentSignals(companyId, rowById, now);
    }

    const liveSignals = liveReassignmentSignals(companyId, rowById, now);
    const liveSignalIssues = new Set(liveSignals.map((signal) => signal.issueId));
    const liveByReviewer = new Map<string, number>();
    for (const [agentId, load] of await deps.store.loadByAgent(companyId)) {
      liveByReviewer.set(agentId, load);
    }
    // Per-pass snapshot of the loads the moves must reduce: the wake lane
    // bumps them afterwards, and rebalancing must judge the queues the pass
    // started with, not the lanes' own wake bumps.
    const initialLoads = new Map(liveByReviewer);
    const activeStageIdsByIssue = new Map(pending.map(({ row }) => {
      const policy = typeof row.executionPolicy === "object" && row.executionPolicy !== null
        ? (row.executionPolicy as Record<string, unknown>)
        : {};
      const stages = Array.isArray(policy.stages) ? policy.stages : [];
      const state = typeof row.executionState === "object" && row.executionState !== null
        ? (row.executionState as Record<string, unknown>)
        : {};
      const participant = typeof state.currentParticipant === "object" && state.currentParticipant !== null
        ? (state.currentParticipant as Record<string, unknown>)
        : {};
      const ids = stages.filter((stage): stage is Record<string, unknown> => typeof stage === "object" && stage !== null)
        .filter((stage) => stage.type === "review" && stage.id === state.currentStageId)
        .filter((stage) => Array.isArray(stage.participants) && stage.participants.some((p) => {
          if (typeof p !== "object" || p === null) return false;
          const principal = p as Record<string, unknown>;
          return principal.type === "agent" && principal.agentId === participant.agentId;
        }))
        .map((stage) => stage.id)
        .filter((id): id is string => typeof id === "string");
      return [row.id, new Set(ids)] as const;
    }));
    const activeStages = pending.filter(({ row, review }) => {
      const state = typeof row.executionState === "object" && row.executionState !== null
        ? (row.executionState as Record<string, unknown>)
        : {};
      const participant = typeof state.currentParticipant === "object" && state.currentParticipant !== null
        ? (state.currentParticipant as Record<string, unknown>)
        : {};
      return state.status === "pending" && state.currentStageType === "review" && state.currentStageId === review.stageId && participant.type === "agent" && participant.agentId === review.reviewerAgentId && activeStageIdsByIssue.get(row.id)?.has(review.stageId) === true;
    });
    const orderedPending = [...activeStages].sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime());
    const reviewersWoken = new Set<string>();
    for (const { row, review } of orderedPending) {
      if (reviewersWoken.has(review.reviewerAgentId)) continue;
      // myrmidon(OPE-12886): liveness is about runs, not queue depth. On the
      // incident of 13.11 every reviewer sat idle (0 runs) behind 4-7 assigned
      // in_review tasks, so any load-derived skip here skipped ALL of them:
      // `loadByAgent` counts pending in_review tasks plus active runs, hence a
      // reviewer awaiting a review always has load >= 1 and a
      // `load > 0 && load <= queueThreshold` gate skips every reviewer with a
      // queue of 1..queueThreshold. The queue is owned by the
      // offload/rebalance lanes (load > queueThreshold below); the liveness
      // lane's contract is "idle reviewer gets woken on the oldest stale
      // review", regardless of queue size.
      try {
        const activeRunCount = await deps.store.countActiveRunsForAgent(companyId, review.reviewerAgentId);
        if (activeRunCount > 0) continue;
        const wakeState = await deps.store.reviewWakeState({
          companyId,
          issueId: row.id,
          reviewerAgentId: review.reviewerAgentId,
          stageId: review.stageId,
        });
        if (wakeState.activeRun || wakeState.pendingWake) continue;
        // myrmidon(OPE-11947): an exhausted series is escalated once (a
        // wake_escalation_required row newer than the last wake means it was),
        // not on every pass, and it is re-armed after REVIEW_WAKE_REARM_AFTER_MS
        // since its last attempt: the next wake then opens a new series at
        // attempt 1 with the backoff counted from the start.
        let seriesAttempts = wakeState.attempts;
        if (seriesAttempts >= REVIEW_WAKE_MAX_ATTEMPTS) {
          const escalated = wakeState.lastEscalationAt != null
            && (!wakeState.lastWakeAt || wakeState.lastEscalationAt.getTime() > wakeState.lastWakeAt.getTime());
          if (!escalated) {
            await deps.store.recordReviewWakeEscalation({ companyId, issueId: row.id, reviewerAgentId: review.reviewerAgentId, stageId: review.stageId, attempts: wakeState.attempts, at: now });
            log.warn({ companyId, issueId: row.id, reviewerId: review.reviewerAgentId, stageId: review.stageId, attempts: wakeState.attempts }, "review routing wake retries exhausted; escalation persisted for ADM");
          }
          const rearmed = wakeState.lastWakeAt != null
            && now.getTime() - wakeState.lastWakeAt.getTime() >= REVIEW_WAKE_REARM_AFTER_MS;
          if (!rearmed) continue;
          seriesAttempts = 0;
        }
        // Cancelled runs for the same reviewer/task are direct evidence of a
        // failed dispatch: retry on bounded backoff, without the initial stale delay.
        const retryAnchor = wakeState.lastCancelledRunAt && (!wakeState.lastWakeAt || wakeState.lastCancelledRunAt > wakeState.lastWakeAt)
          ? wakeState.lastCancelledRunAt
          : wakeState.lastWakeAt;
        if (retryAnchor) {
          const backoffMs = Math.min(REVIEW_WAKE_MAX_BACKOFF_MS, REVIEW_WAKE_RETRY_BACKOFF_MS * 2 ** Math.max(0, seriesAttempts - 1));
          if (now.getTime() - retryAnchor.getTime() < backoffMs) continue;
        } else {
          const lastActivity = row.updatedAt ?? row.createdAt;
          if (now.getTime() - lastActivity.getTime() < REVIEW_WAKE_STALE_AFTER_MS) continue;
        }
        const attempt = seriesAttempts + 1;
        const wakeContext = buildReviewRoutingWakeContext(
          (row.executionState ?? {}) as Record<string, unknown>,
        );
        const currentStage = review.stageId;
        // myrmidon(OPE-12886): the active-run check already ran at the top of
        // this iteration (and would have skipped this reviewer); the budget
        // cap stays the last gate so a burst of wakes can never exceed one
        // dispatch per reviewer per pass and the company-wide ceiling.
        if (reviewersWoken.size >= REVIEW_ROUTING_MAX_WAKES_PER_PASS) break;
        // Persist the wake request before dispatch: a failure while enqueuing
        // still observes the cooldown on the next sweep rather than looping.
        reviewersWoken.add(review.reviewerAgentId); // Reserve the per-reviewer dispatch budget even if dispatch rejects.
        await deps.store.recordReviewWake({
          companyId,
          issueId: row.id,
          reviewerAgentId: review.reviewerAgentId,
          stageId: currentStage,
          at: now,
          attempt,
        });
        await deps.wakeReviewer(review.reviewerAgentId, {
          issueId: row.id,
          reason: "execution_review_requested",
          mutation: "myrmidon_review_wakeup_retry",
          executionStage: wakeContext as unknown as Record<string, unknown>,
          retryAttempt: attempt,
        });
        liveByReviewer.set(review.reviewerAgentId, (liveByReviewer.get(review.reviewerAgentId) ?? 0) + 1);
        result.woken += 1;
      } catch (err) {
        result.failed += 1;
        log.warn({ err, issueId: row.id, reviewerId: review.reviewerAgentId }, "review routing failed to wake a stale reviewer");
      }
    }

    const history = await deps.store.routingHistory(
      companyId,
      pending.map((entry) => entry.row.id),
    );
    const overdue: typeof pending = [];
    for (const entry of pending) {
      const routed = history.get(entry.row.id);
      let since: Date | null = routed !== undefined ? routed.lastAt : null;

      if (deps.prResolver) {
        try {
          const prProduct = await deps.store.findPrWorkProduct(companyId, entry.row.id);
          if (prProduct) {
            const head = await deps.prResolver.resolve({
              companyId,
              repository: prProduct.repository,
              number: prProduct.number,
            });
            if (head.fetchFailed || head.reviewDecision !== null) {
              continue;
            }
            if (head.ci === "green") {
              if (!since) {
                since = entry.row.updatedAt ?? entry.row.createdAt;
              }
            } else {
              if (routed === undefined) {
                continue;
              }
            }
          }
        } catch (err) {
          log.warn({ err, issueId: entry.row.id }, "failed to resolve PR head for in-review issue");
          continue;
        }
      }

      if (!since) {
        continue;
      }

      const isOverdue = isReviewOverdue({
        since,
        now,
        afterHours: settings.reassignAfterHours,
        afterMinutes: settings.reassignAfterMinutes,
      });

      if (isOverdue) {
        overdue.push(entry);
      }
    }
    const overloaded = pending.filter((entry) => {
      if (overdue.includes(entry)) return false;
      if (isEscalatedReviewStage(entry.row)) return false;
      const currentLoad = liveByReviewer.get(entry.review.reviewerAgentId) ?? 0;
      return currentLoad > settings.queueThreshold;
    });

    const signals: ReviewRoutingSignal[] = [];
    let moves = 0;
    let reviewerPool: ReviewerCandidate[] | null = null;
    const globalPool = async (): Promise<ReviewerCandidate[]> => {
      if (reviewerPool) return reviewerPool;
      const [agentRows, load] = await Promise.all([
        deps.store.listReviewerAgents(companyId, settings.reviewerRoles),
        deps.store.loadByAgent(companyId),
      ]);
      reviewerPool = agentRows.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        model: agent.model ?? null,
        metadata: agent.metadata,
        swarmQueueEligible: agent.metadata?.["swarmQueueEligible"] !== false,
        invokable: agent.invokable ?? true,
        load: load.get(agent.id) ?? 0,
      }));
      return reviewerPool;
    };
    const pool = globalPool;
    const agentGroupCache = new Map<string, string>();
    const getAgentGroup = async (agentId?: string | null): Promise<string> => {
      if (!agentId) return "";
      const cached = agentGroupCache.get(agentId);
      if (cached !== undefined) return cached;
      const fromPool = (await pool()).find((c) => c.id === agentId);
      if (fromPool) {
        const key = resolveAgentGroupKey(fromPool);
        agentGroupCache.set(agentId, key);
        return key;
      }
      const fromStore = await deps.store.getAgent(companyId, agentId);
      const key = resolveAgentGroupKey(fromStore);
      agentGroupCache.set(agentId, key);
      return key;
    };
    const getIssueGroupKey = async (row: RoutingIssue, currentReviewerId?: string): Promise<string> => {
      const anchorId = issueAnchorAgentId(row);
      if (anchorId) {
        const group = await getAgentGroup(anchorId);
        if (group) return group;
      }
      if (currentReviewerId) {
        const group = await getAgentGroup(currentReviewerId);
        if (group) return group;
      }
      return "";
    };
    // myrmidon(OPE-12683): a task is reviewed only inside its own agent group
    // by queue-eligible reviewers. An empty own group yields an empty pool, never
    // the whole company pool: shop and business bots must not review dev tasks.
    const poolForGroup = async (groupKey: string): Promise<ReviewerCandidate[]> =>
      ownGroupReviewerPool(await pool(), groupKey);
    const bumpLoad = (agentId: string, delta: number) => {
      if (reviewerPool) {
        const candidate = reviewerPool.find((entry) => entry.id === agentId);
        if (candidate) candidate.load = Math.max(0, candidate.load + delta);
      }
    };

    for (const row of needing) {
      const signal: ReviewRoutingSignal = {
        kind: "no_reviewer",
        issueId: row.id,
        companyId,
        identifier: row.identifier,
        title: row.title,
        since: now.toISOString(),
        hoursInReview: null,
      };
      if (moves >= REVIEW_ROUTING_MAX_MOVES_PER_PASS) continue;
      try {
        let candidates: ReviewerCandidate[];
        try {
          const groupKey = await getIssueGroupKey(row);
          candidates = await poolForGroup(groupKey);
        } catch (error) {
          log.warn({ err: error, issueId: row.id, companyId }, "Review-routing reviewer lookup failed");
          signals.push(signal);
          result.failed += 1;
          continue;
        }
        const authorModel = row.createdByAgentId
          ? await deps.store.getAgentModel?.(companyId, row.createdByAgentId) ?? null
          : null;
        const picked = pickReviewer({
          candidates,
          excluded: excludedReviewerIds(row),
          maxLoad: settings.maxLoadPerReviewer,
          authorModel,
        });
        if (!picked) {
          signals.push(signal);
          result.signaled += 1;
          continue;
        }
        const state = await assign(row, picked);
        if (state) {
          moves += 1;
          result.assigned += 1;
          bumpLoad(picked.id, 1);
        }
        // A lost race (someone else assigned) is neither a signal nor a failure.
      } catch (err) {
        result.failed += 1;
        log.warn({ err, issueId: row.id }, "review routing failed to assign a reviewer");
      }
    }

    for (const { row, review } of overdue) {
      const routed = history.get(row.id);
      const sinceDate = routed?.lastAt ?? row.updatedAt ?? row.createdAt;
      const hoursInReview = hoursSince(sinceDate, now);
      const signal: ReviewRoutingSignal = {
        kind: "review_overdue",
        issueId: row.id,
        companyId,
        identifier: row.identifier,
        title: row.title,
        since: now.toISOString(),
        hoursInReview,
      };
      if (moves >= REVIEW_ROUTING_MAX_MOVES_PER_PASS) {
        signals.push(signal);
        result.signaled += 1;
        continue;
      }
      try {
        const groupKey = await getIssueGroupKey(row, review.reviewerAgentId);
        const candidates = await poolForGroup(groupKey);
        const authorModel = row.createdByAgentId
          ? await deps.store.getAgentModel?.(companyId, row.createdByAgentId) ?? null
          : null;
        const alreadyRoutedReviewerIds = routed?.reviewerAgentIds ?? [];
        const picked = pickReviewer({
          candidates,
          excluded: excludedReviewerIds(row, [
            ...alreadyRoutedReviewerIds,
            review.reviewerAgentId,
            ...(review.returnAssigneeAgentId ? [review.returnAssigneeAgentId] : []),
          ]),
          maxLoad: settings.maxLoadPerReviewer,
          authorModel,
        });
        if (!picked) {
          signals.push(signal);
          result.signaled += 1;
          continue;
        }
        const state = await reassign(row, review.reviewerAgentId, picked, hoursInReview, undefined, {
          sinceDate,
          now,
          reassignAfterMinutes: settings.reassignAfterMinutes,
        });
        if (state) {
          moves += 1;
          result.reassigned += 1;
          result.signaled += 1;
          bumpLoad(picked.id, 1);
          bumpLoad(review.reviewerAgentId, -1);
          recentReassignments.set(row.id, {
            signal,
            untilMs: now.getTime() + REVIEW_ROUTING_REASSIGN_SIGNAL_TTL_MS,
          });
        } else {
          signals.push(signal);
          result.signaled += 1;
        }
      } catch (err) {
        signals.push(signal);
        result.failed += 1;
        log.warn({ err, issueId: row.id }, "review routing failed to reassign a reviewer");
      }
    }

    for (const { row, review } of overloaded) {
      const signal: ReviewRoutingSignal = {
        kind: "review_overdue",
        issueId: row.id,
        companyId,
        identifier: row.identifier,
        title: row.title,
        since: now.toISOString(),
        hoursInReview: null,
      };
      if (moves >= REVIEW_ROUTING_MAX_MOVES_PER_PASS) {
        signals.push(signal);
        result.signaled += 1;
        continue;
      }
      try {
        const currentLoad = liveByReviewer.get(review.reviewerAgentId) ?? 0;
        const groupKey = await getIssueGroupKey(row, review.reviewerAgentId);
        const candidates = await poolForGroup(groupKey);
        const authorModel = row.createdByAgentId
          ? await deps.store.getAgentModel?.(companyId, row.createdByAgentId) ?? null
          : null;
        const picked = pickReviewer({
          candidates,
          excluded: excludedReviewerIds(row, [
            ...routedReviewerIds(history, row.id),
            review.reviewerAgentId,
            ...(review.returnAssigneeAgentId ? [review.returnAssigneeAgentId] : []),
          ]),
          maxLoad: settings.maxLoadPerReviewer,
          authorModel,
        });
        if (!picked || picked.load >= currentLoad) {
          signals.push(signal);
          result.signaled += 1;
          continue;
        }
        const state = await reassign(row, review.reviewerAgentId, picked, 0, {
          reason: "queue",
          currentLoad,
          threshold: settings.queueThreshold,
        });
        if (state) {
          moves += 1;
          result.reassigned += 1;
          result.signaled += 1;
          bumpLoad(picked.id, 1);
          bumpLoad(review.reviewerAgentId, -1);
          liveByReviewer.set(review.reviewerAgentId, Math.max(0, currentLoad - 1));
          recentReassignments.set(row.id, {
            signal,
            untilMs: now.getTime() + REVIEW_ROUTING_REASSIGN_SIGNAL_TTL_MS,
          });
        } else {
          signals.push(signal);
          result.signaled += 1;
        }
      } catch (err) {
        signals.push(signal);
        result.failed += 1;
        log.warn({ err, issueId: row.id }, "review routing failed to offload an overloaded reviewer");
      }
    }

    if (settings.rebalanceAfterMinutes > 0 && moves < REVIEW_ROUTING_MAX_MOVES_PER_PASS) {
      const overdueIds = new Set(overdue.map((entry) => entry.row.id));
      for (const { row, review } of pending) {
        if (moves >= REVIEW_ROUTING_MAX_MOVES_PER_PASS) break;
        if (overdueIds.has(row.id)) continue;
        // The wake liveness lane owns reviews of idle reviewers: rebalancing
        // must not duplicate its single-dispatch budget, so only a reviewer
        // actually holding a queue is a candidate for an idle-pool handoff.
        if ((initialLoads.get(review.reviewerAgentId) ?? 0) <= 0) continue;
        // Escalation lives in the raw execution state: any escalation marker
        // (reason, target, policy revision) or an exhausted round circuit
        // breaker means ADM owns the stage.
        const stateRecord = asRecord(row.executionState);
        const escalatedRoundCount = typeof stateRecord?.changesRequestedCount === "number" &&
          stateRecord.changesRequestedCount >= 3;
        if (
          escalatedRoundCount ||
          stateRecord?.escalationToParticipant ||
          stateRecord?.escalationPolicyRevision ||
          stateRecord?.escalationReason
        ) {
          continue;
        }

        const routed = history.get(row.id);
        const waitingSince = routed?.lastAt ?? row.updatedAt;
        const waitingMinutes = Math.max(0, Math.floor((now.getTime() - waitingSince.getTime()) / 60_000));
        if (waitingMinutes < settings.rebalanceAfterMinutes) {
          continue;
        }

        // myrmidon(OPE-12683): only queue-eligible reviewers of the issue's own
        // group may take a rebalanced review; none in the group, no rebalance.
        let candidates: ReviewerCandidate[];
        try {
          candidates = await poolForGroup(await getIssueGroupKey(row, review.reviewerAgentId));
        } catch (err) {
          result.failed += 1;
          log.warn({ err, issueId: row.id, companyId }, "review routing failed to read the own-group pool for a rebalance");
          continue;
        }
        const excluded = excludedReviewerIds(row, [
          review.reviewerAgentId,
          ...(review.returnAssigneeAgentId ? [review.returnAssigneeAgentId] : []),
        ]);

        const emptyCandidates = candidates.filter(
          (c) => c.invokable !== false && !excluded.has(c.id) && c.load === 0,
        );
        if (emptyCandidates.length === 0) {
          continue;
        }

        emptyCandidates.sort((a, b) => a.id.localeCompare(b.id));
        const picked = emptyCandidates[0];

        try {
          const state = await rebalance(row, review.reviewerAgentId, picked, waitingMinutes);
          if (state) {
            moves += 1;
            result.reassigned += 1;
            bumpLoad(picked.id, 1);
            bumpLoad(review.reviewerAgentId, -1);
          }
        } catch (err) {
          result.failed += 1;
          log.warn({ err, issueId: row.id }, "review routing failed to rebalance a reviewer");
        }
      }
    }

    return [
      ...signals,
      ...liveReassignmentSignals(companyId, rowById, now).filter(
        (recent) => !signals.some((signal) => signal.issueId === recent.issueId),
      ),
    ];
  }

  /** Cards of recent reassignments whose task is still in review and within the TTL. */
  function liveReassignmentSignals(
    companyId: string,
    rowById: ReadonlyMap<string, InReviewIssueRow>,
    now: Date,
  ): ReviewRoutingSignal[] {
    const live: ReviewRoutingSignal[] = [];
    for (const [issueId, entry] of recentReassignments) {
      if (entry.untilMs <= now.getTime() || (entry.signal.companyId === companyId && !rowById.has(issueId))) {
        recentReassignments.delete(issueId);
        continue;
      }
      if (entry.signal.companyId === companyId) live.push(entry.signal);
    }
    return live;
  }

  /**
   * The 1.6.5 PR lane: watch open pull requests, route a review task the
   * moment a head turns green without a verdict, a merge-steward task when it
   * is approved, and supersede tasks whose recorded head moved on. Runs on its
   * own `pollIntervalSec` throttle (the task lane keeps the pass interval);
   * without a resolver or with the lane disabled it stays inert. A GitHub read
   * failure skips the PR and counts as NO failure metric — an outage must
   * neither create nor close tasks, and must not look like a broken sweep.
   */
  async function sweepPrLane(
    companyId: string,
    settings: ReviewRoutingSettings,
    now: Date,
    result: ReviewRoutingSweepResult,
    force: boolean,
  ): Promise<ReviewRoutingSignal[] | null> {
    const prWatch = settings.prWatch;
    if (!prWatch.enabled) {
      prLaneSignalsByCompany.delete(companyId);
      return [];
    }
    if (!deps.prResolver) return null;
    if (!force && now.getTime() - lastPrLaneAtMs < prWatch.pollIntervalSec * 1000) return null;
    lastPrLaneAtMs = now.getTime();

    const signals: ReviewRoutingSignal[] = [];
    // myrmidon(OPE-12683): a pull request is reviewed only inside the agent
    // group of its engineer or author, by queue-eligible reviewers. A group is
    // resolved from the agent row; an unknown group (no engineer, no linked
    // author) leaves only the queue-eligibility filter.
    const laneGroupByAgent = new Map<string, string>();
    const laneAgentGroup = async (agentId: string | null | undefined): Promise<string> => {
      if (!agentId) return "";
      const cached = laneGroupByAgent.get(agentId);
      if (cached !== undefined) return cached;
      const key = resolveAgentGroupKey(await deps.store.getAgent(companyId, agentId));
      laneGroupByAgent.set(agentId, key);
      return key;
    };
    const existingWork = await deps.store.listInProgressPrIssues(companyId, REVIEW_ROUTING_PR_PAGE_SIZE);
    for (const row of existingWork) {
      try {
        const product = await deps.store.findPrWorkProduct(companyId, row.id);
        if (!product) continue;
        const head = await deps.prResolver.resolve({ companyId, repository: product.repository, number: product.number });
        result.prScanned += 1;
        if (head.reviewDecision !== null) continue;
        if (!shouldRouteOpenPrToReview(head)) continue;
        const [reviewerRows, boardLoad, openReviewLoad] = await Promise.all([
          deps.store.listReviewerAgents(companyId, settings.reviewerRoles),
          deps.store.loadByAgent(companyId),
          deps.store.openPrTaskLoadByAgent(companyId, "review"),
        ]);
        const taskGroup = await laneAgentGroup(issueAnchorAgentId(row));
        const picked = pickPrReviewer({
          reviewers: ownGroupReviewerPool(reviewerRows.map((agent) => ({ ...agent, load: 0 })), taskGroup),
          boardLoadByAgent: boardLoad,
          openPrLoadByAgent: openReviewLoad,
          excluded: new Set([row.assigneeAgentId ?? "", row.createdByAgentId ?? ""]),
          maxLoadPerReviewer: settings.maxLoadPerReviewer,
          maxOpenReviewsPerReviewer: prWatch.maxOpenReviewsPerReviewer,
        });
        if (!picked) continue;
        const applied = await deps.store.applyPatch({
          issueId: row.id,
          companyId,
          guard: (fresh) => fresh.status === "in_progress" && fresh.assigneeAgentId === row.assigneeAgentId,
          build: (fresh) => buildReviewRoutingAssignPatch({ issue: fresh, reviewerAgentId: picked.id }),
        });
        if (!applied) continue;
        await deps.logActivity({
          companyId,
          action: REVIEW_ROUTING_ASSIGNED_ACTION,
          issueId: row.id,
          details: { reviewerAgentId: picked.id, reviewerRole: picked.role, reason: "existing_pr_ci_wait", repository: product.repository, pullRequest: product.number, ci: head.ci },
        });
        await deps.addComment(row.id,
          `Automatic review routing: ${product.repository}#${product.number} is open, non-draft, mergeable, and CI is pending or green. This task is now in review; the original assignee will resume only if changes are requested.`,
          { presentation: notice("PR waiting for CI/review"), metadata: metadataFor({ "Pull request": `${product.repository}#${product.number}`, CI: head.ci, Reviewer: picked.id }) });
        await wake(row, picked.id, applied.executionState, "myrmidon_review_routing_pr_wait");
        result.assigned += 1;
        result.prTasksCreated += 1;
      } catch (err) {
        result.failed += 1;
        log.warn({ err, issueId: row.id }, "review routing failed to hand off an existing PR task");
      }
    }
    // Source (a): webhook-fed rows.
    const candidates = new Map<string, { repository: string; number: number }>();
    for (const row of await deps.store.listPrCandidates(companyId, REVIEW_ROUTING_PR_PAGE_SIZE)) {
      candidates.set(`${row.repository}#${row.number}`, { repository: row.repository, number: row.number });
    }
    // Source (b): the repo poll, at most once per pollIntervalSec per repo
    // (this lane's own throttle is the per-repo clock). Configured repos win;
    // with none configured, every repo the instance has seen PRs of.
    const repos =
      prWatch.repositories.length > 0
        ? prWatch.repositories
        : [...new Set([...candidates.keys()].map((key) => key.slice(0, key.lastIndexOf("#")))), ...(await deps.store.listKnownPrRepositories(companyId))];
    if (deps.prResolver.listOpenPullRequests) {
      for (const repository of repos) {
        let listed: Awaited<ReturnType<PullRequestHeadResolver["listOpenPullRequests"]>> = [];
        try {
          listed = await deps.prResolver.listOpenPullRequests({ companyId, repository });
        } catch (err) {
          log.warn({ err, companyId, repository }, "review routing PR lane repo poll failed");
        }
        for (const pr of listed) candidates.set(`${repository}#${pr.number}`, { repository, number: pr.number });
      }
    }

    if (candidates.size === 0) return signals;

    // One pool set per pass; loads bump as the lane creates tasks so a batch
    // spreads (the same counting the task lane does).
    const [reviewerRows, stewardRows, boardLoad, openReviewLoad, openMergeLoad] = await Promise.all([
      deps.store.listReviewerAgents(companyId, settings.reviewerRoles),
      deps.store.listReviewerAgents(companyId, prWatch.steward.roles),
      deps.store.loadByAgent(companyId),
      deps.store.openPrTaskLoadByAgent(companyId, "review"),
      deps.store.openPrTaskLoadByAgent(companyId, "merge"),
    ]);
    const reviewers: ReviewerCandidate[] = reviewerRows.map((agent) => ({ ...agent, invokable: agent.invokable ?? true, load: 0 }));
    const stewards: ReviewerCandidate[] = stewardRows.map((agent) => ({ id: agent.id, role: agent.role, load: 0 }));
    const openReviewByAgent = new Map(openReviewLoad);
    const openMergeByAgent = new Map(openMergeLoad);

    // Coverage: open pr-routing tasks per (repo, number, kind), and the
    // author-exclusion cache (GitHub login -> linked agent ids).
    const coverage = new Map<string, PrRoutedTask[]>();
    for (const task of await deps.store.listOpenPrRoutingTasks(companyId)) {
      const key = prRoutingCoverageKey({ repository: task.repository, number: task.number, kind: task.kind });
      const bucket = coverage.get(key) ?? [];
      bucket.push(task);
      coverage.set(key, bucket);
    }
    const authorAgents = new Map<string, string[]>();
    const authorExcluded = async (login: string | null | undefined): Promise<Set<string>> => {
      if (!login) return new Set();
      let ids = authorAgents.get(login.toLowerCase());
      if (!ids) {
        ids = await deps.store.findAgentIdsByGitHubLogin(companyId, login);
        authorAgents.set(login.toLowerCase(), ids);
      }
      return new Set(ids);
    };
    // myrmidon(OPE-12683): the reviewers of a pull request are those of the
    // group(s) of the author's linked agents. An author with no linked agent
    // has no known group: only the queue-eligibility filter applies.
    const reviewersForAuthor = async (login: string | null | undefined): Promise<ReviewerCandidate[]> => {
      const groups = new Set<string>();
      for (const agentId of await authorExcluded(login)) {
        const group = await laneAgentGroup(agentId);
        if (group) groups.add(group);
      }
      if (groups.size === 0) return ownGroupReviewerPool(reviewers, "");
      return [...groups].flatMap((group) => ownGroupReviewerPool(reviewers, group));
    };

    let newAssignments = 0;
    for (const candidate of candidates.values()) {
      let head;
      try {
        head = await deps.prResolver.resolve({ companyId, repository: candidate.repository, number: candidate.number });
      } catch (err) {
        // The resolver swallows GitHub trouble into fetchFailed; a throw is a
        // code fault — log it, count nothing that the desk would misread, and
        // skip this PR.
        log.warn({ err, companyId, pr: `${candidate.repository}#${candidate.number}` }, "review routing PR resolver failed");
        continue;
      }
      result.prScanned += 1;
      if (head.fetchFailed || !head.open || !head.headSha) continue;
      const pr = { repository: head.repository, number: head.number };

      // Supersede first (rule 6): tasks recorded against a dead head are
      // cancelled so the current head's task is not blocked by its coverage.
      for (const kind of ["review", "merge"] as const) {
        const bucketKey = prRoutingCoverageKey({ ...pr, kind });
        const bucket = coverage.get(bucketKey) ?? [];
        const stale = bucket.filter((task) => prTaskIsSuperseded(task, head.headSha!));
        const live = bucket.filter((task) => !stale.includes(task));
        for (const task of stale) {
          try {
            const cancelled = await deps.store.cancelPrRoutingTask({ issueId: task.issueId, companyId });
            if (!cancelled) continue;
            result.prSuperseded += 1;
            await deps.addComment(
              task.issueId,
              `Automatic review routing: this task was created for pull request head ` +
                `\`${task.headSha}\`, but ${pr.repository}#${pr.number} now carries head \`${head.headSha}\`. ` +
                "The task is superseded and cancelled; the new head is routed on this same pass.",
              {
                presentation: { ...notice("PR routing superseded"), tone: "warning" },
                metadata: metadataFor({
                  "Pull request": `${pr.repository}#${pr.number}`,
                  "Superseded head": String(task.headSha),
                  "Current head": head.headSha,
                }),
              },
            );
          } catch (err) {
            result.failed += 1;
            log.warn({ err, issueId: task.issueId }, "review routing failed to supersede a task");
          }
        }
        coverage.set(bucketKey, live);
      }

      // Native PR approval propagation from board review APPROVE decisions
      // (or during PR sync review lane processing)
      if (deps.approvalPropagator) {
        const hasBoardApproval =
          head.reviewDecision === "APPROVED" ||
          (deps.store.hasApprovedBoardReview
            ? await deps.store.hasApprovedBoardReview({
                companyId,
                repository: pr.repository,
                number: pr.number,
                headSha: head.headSha,
              })
            : false);

        if (hasBoardApproval) {
          try {
            const propRes = await deps.approvalPropagator({
              companyId,
              repository: pr.repository,
              number: pr.number,
              headSha: head.headSha,
              reviewedHeadSha: head.headSha,
            });
            if (propRes.success && propRes.action !== "noop" && propRes.action !== "skipped") {
              result.prApprovalsPropagated += 1;
            }
          } catch (err) {
            log.warn({ err, companyId, pr: `${pr.repository}#${pr.number}` }, "approval propagation failed during PR lane sweep");
          }
        }
      }

      const reviewDue = reviewTaskDueForHead(head);
      const stewardDue = prWatch.steward.enabled && stewardTaskDueForHead(head);
      if (!reviewDue && !stewardDue) continue;

      for (const kind of (["review", "merge"] as const)) {
        const due = kind === "review" ? reviewDue : stewardDue;
        if (!due) continue;
        const bucketKey = prRoutingCoverageKey({ ...pr, kind });
        if ((coverage.get(bucketKey) ?? []).some((task) => task.headSha === head.headSha)) continue;
        if (newAssignments >= prWatch.maxNewAssignmentsPerPass) continue;

        const excluded = kind === "review" ? await authorExcluded(head.authorLogin) : new Set<string>();
        const picked =
          kind === "review"
            ? pickPrReviewer({
                reviewers: await reviewersForAuthor(head.authorLogin),
                boardLoadByAgent: boardLoad,
                openPrLoadByAgent: openReviewByAgent,
                excluded,
                maxLoadPerReviewer: settings.maxLoadPerReviewer,
                maxOpenReviewsPerReviewer: prWatch.maxOpenReviewsPerReviewer,
              })
            : pickPrReviewer({
                reviewers: stewards,
                boardLoadByAgent: boardLoad,
                openPrLoadByAgent: openMergeByAgent,
                excluded,
                // The steward lane has its own ceiling only (spec rule 5): a
                // busy steward may still merge; the merge count is the gate.
                maxLoadPerReviewer: Number.POSITIVE_INFINITY,
                maxOpenReviewsPerReviewer: prWatch.steward.maxMergesPerSteward,
              });
        if (!picked) {
          const signal: ReviewRoutingSignal = {
            kind: kind === "review" ? "no_reviewer" : "no_steward",
            issueId: prSignalSubjectId(pr.repository, pr.number),
            companyId,
            identifier: null,
            title: kind === "review" ? prReviewTaskTitle(head) : prStewardTaskTitle(head),
            since: now.toISOString(),
            hoursInReview: null,
            pr: { repository: pr.repository, number: pr.number, headSha: head.headSha },
          };
          if (!signals.some((existing) => existing.kind === signal.kind && existing.issueId === signal.issueId)) {
            signals.push(signal);
            result.signaled += 1;
          }
          continue;
        }

        const patch = buildPrRoutingTaskPatch({ reviewerAgentId: picked.id });
        const title = kind === "review" ? prReviewTaskTitle(head) : prStewardTaskTitle(head);
        const description = prRoutingTaskDescription(head, kind);
        try {
          const created = await deps.store.createPrRoutingTask({
            companyId,
            repository: pr.repository,
            number: pr.number,
            kind,
            headSha: head.headSha!,
            title,
            description,
            status: patch.status,
            assigneeAgentId: patch.assigneeAgentId,
            executionPolicy: patch.executionPolicy,
            executionState: patch.executionState,
            prUrl: head.url ?? null,
            prTitle: head.title ?? null,
            authorLogin: head.authorLogin ?? null,
            baseRef: head.baseRef ?? null,
            draft: head.draft,
          });
          if (!created.issueId) continue; // guard lost or create refused: retry next pass
          newAssignments += 1;
          if (kind === "review") {
            result.prTasksCreated += 1;
            openReviewByAgent.set(picked.id, (openReviewByAgent.get(picked.id) ?? 0) + 1);
          } else {
            result.stewardTasksCreated += 1;
            openMergeByAgent.set(picked.id, (openMergeByAgent.get(picked.id) ?? 0) + 1);
          }
          boardLoad.set(picked.id, (boardLoad.get(picked.id) ?? 0) + 1);
          (coverage.get(bucketKey) ?? coverage.set(bucketKey, []).get(bucketKey)!).push({
            issueId: created.issueId,
            repository: pr.repository,
            number: pr.number,
            kind,
            headSha: head.headSha,
          });
          await deps.logActivity({
            companyId,
            action: kind === "review" ? REVIEW_ROUTING_PR_TASK_CREATED_ACTION : REVIEW_ROUTING_STEWARD_TASK_CREATED_ACTION,
            issueId: created.issueId,
            details: {
              repository: pr.repository,
              pullRequest: pr.number,
              headSha: head.headSha,
              reviewerAgentId: picked.id,
              reviewerRole: picked.role,
            },
          });
          await wake(
            { id: created.issueId, companyId },
            picked.id,
            patch.executionState,
            kind === "review" ? "myrmidon_review_routing_pr_review" : "myrmidon_review_routing_pr_merge",
          );
        } catch (err) {
          result.failed += 1;
          log.warn({ err, companyId, pr: `${pr.repository}#${pr.number}`, kind }, "review routing failed to create a PR task");
        }
      }
    }
    return signals;
  }

  async function assign(row: InReviewIssueRow, reviewer: ReviewerCandidate) {
    const applied = await deps.store.applyPatch({
      issueId: row.id,
      companyId: row.companyId,
      guard: (fresh) => issueNeedsReviewer(fresh) && !excludedReviewerIds(fresh).has(reviewer.id),
      build: (fresh) => buildReviewRoutingAssignPatch({ issue: fresh, reviewerAgentId: reviewer.id }),
    });
    if (!applied) return null;
    await deps.addComment(
      row.id,
      "Automatic review routing: this task is in review with no reviewer, so a reviewer was assigned " +
        `(least loaded of the reviewer roles, never the task's author or assignee). The reviewer is now the ` +
        "assignee while the review is pending; approving closes the task as done, and requesting changes " +
        "sends it back to the previous assignee.",
      {
        presentation: notice("Reviewer assigned"),
        metadata: metadataFor({ "Reviewer": reviewer.id, "Role": reviewer.role, "Reviewer load": String(reviewer.load) }),
      },
    );
    await wake(row, reviewer.id, applied.executionState, "myrmidon_review_routing_assign");
    await deps.logActivity({
      companyId: row.companyId,
      action: REVIEW_ROUTING_ASSIGNED_ACTION,
      issueId: row.id,
      details: { identifier: row.identifier, reviewerAgentId: reviewer.id, reviewerRole: reviewer.role },
    });
    return applied;
  }

  async function reassign(
    row: InReviewIssueRow,
    previousReviewerId: string,
    reviewer: ReviewerCandidate,
    hoursInReview: number,
    overload?: { reason: "queue"; currentLoad: number; threshold: number },
    options?: { sinceDate?: Date; now?: Date; reassignAfterMinutes?: number },
  ) {
    const applied = await deps.store.applyPatch({
      issueId: row.id,
      companyId: row.companyId,
      guard: (fresh) => readPendingAgentReview(fresh)?.reviewerAgentId === previousReviewerId,
      build: (fresh) => buildReviewRoutingReassignPatch({ issue: fresh, newReviewerAgentId: reviewer.id }),
    });
    if (!applied) return null;
    const minutesInReview =
      options?.sinceDate && options?.now
        ? minutesSince(options.sinceDate, options.now)
        : hoursInReview * 60;
    const durationText =
      options?.reassignAfterMinutes !== undefined
        ? `${minutesInReview} min`
        : `${hoursInReview} h`;
    await deps.addComment(
      row.id,
      overload
        ? `Automatic review routing: the reviewer's queue held ${overload.currentLoad} runs (threshold ${overload.threshold}), so the review was moved to the least-loaded pool member.`
        : `Automatic review routing: this review had no verdict for ${durationText}, so it was moved to ` +
            "another reviewer. An attention card was raised for the operator.",
      {
        presentation: { ...notice("Review reassigned"), tone: "warning" },
        metadata: metadataFor({
          "Previous reviewer": previousReviewerId,
          "New reviewer": reviewer.id,
          ...(overload
            ? {
                Reason: "reviewer-queue-overload",
                "Queue size": String(overload.currentLoad),
                Threshold: String(overload.threshold),
              }
            : {
                "Hours in review": String(hoursInReview),
                "Minutes in review": String(minutesInReview),
              }),
        }),
      },
    );
    await wake(row, reviewer.id, applied.executionState, "myrmidon_review_routing_reassign");
    await deps.logActivity({
      companyId: row.companyId,
      action: REVIEW_ROUTING_REASSIGNED_ACTION,
      issueId: row.id,
      details: {
        identifier: row.identifier,
        reviewerAgentId: reviewer.id,
        previousReviewerAgentId: previousReviewerId,
        hoursInReview,
        minutesInReview,
        ...(overload
          ? { reason: "reviewer-queue-overload", currentLoad: overload.currentLoad, threshold: overload.threshold }
          : {}),
      },
    });
    return applied;
  }

  async function rebalance(
    row: InReviewIssueRow,
    previousReviewerId: string,
    reviewer: ReviewerCandidate,
    waitingMinutes: number,
  ) {
    const applied = await deps.store.applyPatch({
      issueId: row.id,
      companyId: row.companyId,
      guard: (fresh) => readPendingAgentReview(fresh)?.reviewerAgentId === previousReviewerId,
      build: (fresh) => buildReviewRoutingReassignPatch({ issue: fresh, newReviewerAgentId: reviewer.id }),
    });
    if (!applied) return null;
    await deps.addComment(
      row.id,
      `Automatic review routing: this review was waiting for ${waitingMinutes} min while another member of the ` +
        `review pool had an empty queue, so it was rebalanced to @${reviewer.id}.`,
      {
        presentation: notice("Review rebalanced"),
        metadata: metadataFor({
          "Previous reviewer": previousReviewerId,
          "New reviewer": reviewer.id,
          "Role": reviewer.role,
          "Wait minutes": String(waitingMinutes),
        }),
      },
    );
    await wake(row, reviewer.id, applied.executionState, "myrmidon_review_routing_rebalance");
    await deps.logActivity({
      companyId: row.companyId,
      action: REVIEW_ROUTING_REASSIGNED_ACTION,
      issueId: row.id,
      details: {
        identifier: row.identifier,
        reviewerAgentId: reviewer.id,
        reviewerRole: reviewer.role,
        previousReviewerAgentId: previousReviewerId,
        rebalanced: true,
        waitingMinutes,
      },
    });
    return applied;
  }

  /**
   * The change is already committed: a failed wake must not undo it. The
   * reviewer still sees the task on its own heartbeat and in its inbox.
   */
  async function wake(
    row: { id: string; companyId: string },
    reviewerId: string,
    state: Record<string, unknown> | null,
    mutation: string,
  ) {
    try {
      const stageId = typeof state?.currentStageId === "string" ? state.currentStageId : "review";
      const requestedAt = new Date().toISOString();
      const lastWakeState = deps.store.reviewWakeState
        ? await deps.store.reviewWakeState({ companyId: row.companyId, issueId: row.id, reviewerAgentId: reviewerId, stageId })
        : { attempts: 0, lastAt: null };
      if (lastWakeState.attempts >= REVIEW_WAKE_MAX_ATTEMPTS) {
        log.warn({ issueId: row.id, reviewerId, attempts: lastWakeState.attempts }, "review routing wake retry limit reached");
        return null;
      }
      const attempt = lastWakeState.attempts + 1;
      if (deps.store.recordReviewWake) {
        await deps.store.recordReviewWake({ companyId: row.companyId, issueId: row.id, reviewerAgentId: reviewerId, stageId, at: new Date(requestedAt), attempt });
      }
      await deps.wakeReviewer(reviewerId, {
        issueId: row.id,
        reason: "execution_review_requested",
        mutation,
        executionStage: { ...buildReviewRoutingWakeContext(state ?? {}) },
        retryAttempt: attempt,
      });
    } catch (err) {
      log.warn({ err, issueId: row.id, reviewerId }, "review routing wake failed after the assignment was committed");
    }
  }

  return {
    resetForTest() {
      lastSweepAtMs = 0;
      lastPrLaneAtMs = 0;
      recentReassignments.clear();
      prLaneSignalsByCompany.clear();
      boardMerger?.resetForTest();
    },
    async mergeOnEvent(event) {
      if (!boardMerger) return null;
      if (deps.isUnderMaintenance && (await deps.isUnderMaintenance())) return null;
      const settings = await deps.readSettings();
      const now = (deps.now ?? (() => new Date()))();
      if (event.issueId) return boardMerger.mergeIssue(event.companyId, event.issueId, settings, now);
      if (event.repository && event.number) {
        return boardMerger.mergePullRequest(
          event.companyId,
          { repository: event.repository, number: event.number },
          settings,
          now,
        );
      }
      return null;
    },
    async sweep(now = (deps.now ?? (() => new Date()))(), options) {
      const result: ReviewRoutingSweepResult = {
        skippedPass: false,
        scanned: 0,
        assigned: 0,
        reassigned: 0,
        signaled: 0,
        woken: 0,
        failed: 0,
        prScanned: 0,
        prTasksCreated: 0,
        stewardTasksCreated: 0,
        prSuperseded: 0,
        prApprovalsPropagated: 0,
        boardMerged: 0,
        boardReturned: 0,
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
      const companyIds = await deps.store.listActiveCompanyIds();
      for (const companyId of companyIds) {
        if (!settings.enabled) {
          prLaneSignalsByCompany.delete(companyId);
          replaceReviewRoutingSignals(companyId, []);
          continue;
        }
        try {
          const taskSignals = await sweepCompany(companyId, settings, now, result);
          const prSignals = await sweepPrLane(companyId, settings, now, result, options?.force === true);
          // null = the lane did not run this pass (throttled or no resolver):
          // the desk keeps the PR cards of its last actual run.
          if (prSignals !== null) prLaneSignalsByCompany.set(companyId, prSignals);
          const effectivePrSignals = prSignals ?? prLaneSignalsByCompany.get(companyId) ?? [];
          replaceReviewRoutingSignals(companyId, [
            ...taskSignals,
            ...effectivePrSignals.filter(
              (pr) => !taskSignals.some((task) => task.kind === pr.kind && task.issueId === pr.issueId),
            ),
          ]);
        } catch (err) {
          result.failed += 1;
          log.warn({ err, companyId }, "review routing sweep failed for one company");
        }
        // myrmidon(OPE-11767): the board-side merge runs last and on its own, so
        // a GitHub trouble here never costs the desk its signals above.
        if (boardMerger) {
          try {
            const merged = await boardMerger.sweepCompany(companyId, settings, now);
            result.boardMerged += merged.merged;
            result.boardReturned += merged.returned;
            result.failed += merged.failed;
          } catch (err) {
            result.failed += 1;
            log.warn({ err, companyId }, "review routing board merge failed for one company");
          }
        }
      }
      return result;
    },
  };
}
