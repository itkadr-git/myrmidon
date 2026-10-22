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
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type ReviewRoutingSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { prSignalSubjectId, replaceReviewRoutingSignals, type ReviewRoutingSignal } from "./attention.js";
import {
  buildPrRoutingTaskPatch,
  buildReviewRoutingAssignPatch,
  buildReviewRoutingReassignPatch,
  buildReviewRoutingWakeContext,
  excludedReviewerIds,
  hoursSince,
  isReviewOverdue,
  issueNeedsReviewer,
  pickPrReviewer,
  pickReviewer,
  readPendingAgentReview,
  type ReviewerCandidate,
} from "./policy.js";
import {
  prRoutingCoverageKey,
  prReviewTaskTitle,
  prRoutingTaskDescription,
  prStewardTaskTitle,
  prTaskIsSuperseded,
  reviewTaskDueForHead,
  stewardTaskDueForHead,
} from "./pr-policy.js";
import type { PullRequestHeadResolver } from "./github.js";
import type { InReviewIssueRow, ReviewRoutingStore } from "./store.js";
import type { PrRoutedTask } from "./pr-policy.js";

export const DEFAULT_REVIEW_ROUTING_SWEEP_INTERVAL_SEC = 60;
/** Tasks inspected per company per pass (oldest update first). */
export const REVIEW_ROUTING_PAGE_SIZE = 200;
/** PR candidates inspected per company per pass. */
export const REVIEW_ROUTING_PR_PAGE_SIZE = 100;
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
  // --- PR lane (1.6.5, additive) ---------------------------------------------
  /** Open PR candidates this pass looked at. */
  prScanned: number;
  /** Review tasks created for green verdict-less heads. */
  prTasksCreated: number;
  /** Merge-steward tasks created for approved green heads. */
  stewardTasksCreated: number;
  /** Routed tasks cancelled because the PR head moved on. */
  prSuperseded: number;
}

export interface ReviewRoutingSweepDeps {
  store: ReviewRoutingStore;
  readSettings: () => Promise<ReviewRoutingSettings>;
  /** GitHub head resolver; without it the PR lane stays inert (task lane only). */
  prResolver?: PullRequestHeadResolver;
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
  let lastPrLaneAtMs = 0;
  /** Cards of completed reassignments, kept for a day so the desk shows them. */
  const recentReassignments = new Map<string, { signal: ReviewRoutingSignal; untilMs: number }>();
  /** PR-lane signals from the lane's last actual run, kept through throttle gaps. */
  const prLaneSignalsByCompany = new Map<string, ReviewRoutingSignal[]>();

  async function sweepCompany(
    companyId: string,
    settings: ReviewRoutingSettings,
    now: Date,
    result: ReviewRoutingSweepResult,
  ): Promise<ReviewRoutingSignal[]> {
    const rows = await deps.store.listInReviewIssues(companyId, REVIEW_ROUTING_PAGE_SIZE);
    result.scanned += rows.length;

    const rowById = new Map(rows.map((row) => [row.id, row] as const));
    const needing = rows.filter((row) => issueNeedsReviewer(row));
    const pending = rows
      .map((row) => ({ row, review: readPendingAgentReview(row) }))
      .filter((entry): entry is { row: InReviewIssueRow; review: NonNullable<typeof entry.review> } => entry.review !== null);
    if (needing.length === 0 && pending.length === 0) {
      return liveReassignmentSignals(companyId, rowById, now);
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
    const reviewers: ReviewerCandidate[] = reviewerRows.map((agent) => ({ id: agent.id, role: agent.role, load: 0 }));
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
                reviewers,
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
    row: { id: string; companyId: string },
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
      lastPrLaneAtMs = 0;
      recentReassignments.clear();
      prLaneSignalsByCompany.clear();
    },
    async sweep(now = (deps.now ?? (() => new Date()))(), options) {
      const result: ReviewRoutingSweepResult = {
        skippedPass: false,
        scanned: 0,
        assigned: 0,
        reassigned: 0,
        signaled: 0,
        failed: 0,
        prScanned: 0,
        prTasksCreated: 0,
        stewardTasksCreated: 0,
        prSuperseded: 0,
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
      }
      return result;
    },
  };
}
