// myrmidon(REVIEW-ROUTING): the periodic review routing.
//
// One pass per interval, per company, with the settings read fresh on every
// pass (so a change applies without a restart):
//
//  1. a task in `in_review` with no reviewer gets a one-stage review with the
//     least-loaded eligible reviewer (reviewer roles, below the load ceiling,
//     never the task's author or assignee); the choice is written as a system
//     comment and an activity entry, and the reviewer is woken;
//  2. when no reviewer is eligible the task is signalled on the attention desk
//     (`no_reviewer`) instead of staying silent;
//  3. a review this routing started that has had no verdict for
//     `reassignAfterHours` is signalled (`review_overdue`) and moved to another
//     reviewer (never one that already had it); with no other reviewer the
//     signal is what remains.
//
// The sweep is idempotent: the assignment re-checks its premise under a row
// lock, so a second pass (or a racing human) never double-assigns.

import type { Logger } from "pino";
import {
  REVIEW_ROUTING_ASSIGNED_ACTION,
  REVIEW_ROUTING_REASSIGNED_ACTION,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type ReviewRoutingSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { replaceReviewRoutingSignals, type ReviewRoutingSignal } from "./attention.js";
import {
  buildReviewRoutingAssignPatch,
  buildReviewRoutingReassignPatch,
  buildReviewRoutingWakeContext,
  excludedReviewerIds,
  hoursSince,
  isReviewOverdue,
  issueNeedsReviewer,
  pickReviewer,
  readPendingAgentReview,
  type ReviewerCandidate,
} from "./policy.js";
import type { InReviewIssueRow, ReviewRoutingStore } from "./store.js";

export const DEFAULT_REVIEW_ROUTING_SWEEP_INTERVAL_SEC = 60;
/** Tasks inspected per company per pass (oldest update first). */
export const REVIEW_ROUTING_PAGE_SIZE = 200;
/** Assignments and reassignments per company per pass. */
export const REVIEW_ROUTING_MAX_MOVES_PER_PASS = 20;
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
  failed: number;
}

export interface ReviewRoutingSweepDeps {
  store: ReviewRoutingStore;
  readSettings: () => Promise<ReviewRoutingSettings>;
  addComment: (
    issueId: string,
    body: string,
    options: { presentation: IssueCommentPresentation; metadata: IssueCommentMetadata },
  ) => Promise<unknown>;
  wakeReviewer: (
    agentId: string,
    wake: { issueId: string; reason: string; mutation: string; executionStage: Record<string, unknown> },
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
  /** Cards of completed reassignments, kept for a day so the desk shows them. */
  const recentReassignments = new Map<string, { signal: ReviewRoutingSignal; untilMs: number }>();

  async function sweepCompany(
    companyId: string,
    settings: ReviewRoutingSettings,
    now: Date,
    result: ReviewRoutingSweepResult,
  ): Promise<void> {
    const rows = await deps.store.listInReviewIssues(companyId, REVIEW_ROUTING_PAGE_SIZE);
    result.scanned += rows.length;

    const rowById = new Map(rows.map((row) => [row.id, row] as const));
    const needing = rows.filter((row) => issueNeedsReviewer(row));
    const pending = rows
      .map((row) => ({ row, review: readPendingAgentReview(row) }))
      .filter((entry): entry is { row: InReviewIssueRow; review: NonNullable<typeof entry.review> } => entry.review !== null);
    if (needing.length === 0 && pending.length === 0) {
      replaceReviewRoutingSignals(companyId, liveReassignmentSignals(companyId, rowById, now));
      return;
    }

    const history = await deps.store.routingHistory(
      companyId,
      pending.map((entry) => entry.row.id),
    );
    const overdue = pending.filter((entry) => {
      const routed = history.get(entry.row.id);
      return (
        routed !== undefined &&
        isReviewOverdue({ since: routed.lastAt, now, afterHours: settings.reassignAfterHours })
      );
    });

    const signals: ReviewRoutingSignal[] = [];
    let moves = 0;
    let reviewerPool: ReviewerCandidate[] | null = null;
    const pool = async (): Promise<ReviewerCandidate[]> => {
      if (reviewerPool) return reviewerPool;
      const [agentRows, load] = await Promise.all([
        deps.store.listReviewerAgents(companyId, settings.reviewerRoles),
        deps.store.loadByAgent(companyId),
      ]);
      reviewerPool = agentRows.map((agent) => ({ id: agent.id, role: agent.role, load: load.get(agent.id) ?? 0 }));
      return reviewerPool;
    };
    const bumpLoad = (agentId: string, delta: number) => {
      const candidate = reviewerPool?.find((entry) => entry.id === agentId);
      if (candidate) candidate.load = Math.max(0, candidate.load + delta);
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
        const picked = pickReviewer({
          candidates: await pool(),
          excluded: excludedReviewerIds(row),
          maxLoad: settings.maxLoadPerReviewer,
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
      const routed = history.get(row.id)!;
      const signal: ReviewRoutingSignal = {
        kind: "review_overdue",
        issueId: row.id,
        companyId,
        identifier: row.identifier,
        title: row.title,
        since: now.toISOString(),
        hoursInReview: hoursSince(routed.lastAt, now),
      };
      if (moves >= REVIEW_ROUTING_MAX_MOVES_PER_PASS) {
        signals.push(signal);
        result.signaled += 1;
        continue;
      }
      try {
        const picked = pickReviewer({
          candidates: await pool(),
          excluded: excludedReviewerIds(row, [
            ...routed.reviewerAgentIds,
            review.reviewerAgentId,
            ...(review.returnAssigneeAgentId ? [review.returnAssigneeAgentId] : []),
          ]),
          maxLoad: settings.maxLoadPerReviewer,
        });
        if (!picked) {
          signals.push(signal);
          result.signaled += 1;
          continue;
        }
        const state = await reassign(row, review.reviewerAgentId, picked, signal.hoursInReview ?? 0);
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

    replaceReviewRoutingSignals(companyId, [
      ...signals,
      ...liveReassignmentSignals(companyId, rowById, now).filter(
        (recent) => !signals.some((signal) => signal.issueId === recent.issueId),
      ),
    ]);
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
      `Automatic review routing: this review had no verdict for ${hoursInReview} h, so it was moved to ` +
        "another reviewer. An attention card was raised for the operator.",
      {
        presentation: { ...notice("Review reassigned"), tone: "warning" },
        metadata: metadataFor({
          "Previous reviewer": previousReviewerId,
          "New reviewer": reviewer.id,
          "Hours in review": String(hoursInReview),
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
      },
    });
    return applied;
  }

  /**
   * The change is already committed: a failed wake must not undo it. The
   * reviewer still sees the task on its own heartbeat and in its inbox.
   */
  async function wake(
    row: InReviewIssueRow,
    reviewerId: string,
    state: Record<string, unknown> | null,
    mutation: string,
  ) {
    try {
      await deps.wakeReviewer(reviewerId, {
        issueId: row.id,
        reason: "execution_review_requested",
        mutation,
        executionStage: { ...buildReviewRoutingWakeContext(state ?? {}) },
      });
    } catch (err) {
      log.warn({ err, issueId: row.id, reviewerId }, "review routing wake failed after the assignment was committed");
    }
  }

  return {
    resetForTest() {
      lastSweepAtMs = 0;
      recentReassignments.clear();
    },
    async sweep(now = (deps.now ?? (() => new Date()))(), options) {
      const result: ReviewRoutingSweepResult = {
        skippedPass: false,
        scanned: 0,
        assigned: 0,
        reassigned: 0,
        signaled: 0,
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
      const companyIds = await deps.store.listActiveCompanyIds();
      for (const companyId of companyIds) {
        if (!settings.enabled) {
          replaceReviewRoutingSignals(companyId, []);
          continue;
        }
        try {
          await sweepCompany(companyId, settings, now, result);
        } catch (err) {
          result.failed += 1;
          log.warn({ err, companyId }, "review routing sweep failed for one company");
        }
      }
      return result;
    },
  };
}
