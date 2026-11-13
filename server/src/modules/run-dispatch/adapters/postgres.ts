import { hasConversationContinuationPolicy } from "../../../services/conversation-continuation.js";
import { getExecutionBlocker } from "../../../services/execution-blocker.js";
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  issueApprovals,
  issueThreadInteractions,
  heartbeatRuns,
  issueRecoveryActions,
  issueComments,
  issues,
} from "@myrmidon/db";
// OPE-12797 (ORCH-IO-SPLIT): run-event commits in this adapter go through the
// event sink (`createPostgresRunEventSink`), which owns the activity-log
// receipt write; this module no longer imports `activityLog` directly.
import { ISSUE_DISPOSITION_REPAIR_RETRY_REASON } from "@myrmidon/shared";
import { parseObject } from "../../../adapters/utils.js";
import { evaluateAgentInvokabilityFromDb } from "../../../services/agent-invokability.js";
import { budgetService } from "../../../services/budgets.js";
import { isHeartbeatWakeOnDemandEnabled } from "../../../services/heartbeat-policy.js";
import { collectDispositionRepairSourceState } from "../../../services/recovery/disposition-repair.js";
import { createPostgresRunEventSink } from "./event-sink.js";
import type { RunEventSink } from "../application/event-sink.js";
import {
  scheduledRetryPromotedEventCommand,
  scheduledRetrySuppressedEventCommand,
  staleQueuedRunCancelledEventCommand,
} from "../domain/run-event-command.js";
import { emitAgentTaskRun } from "../../../services/agent-task-run-telemetry.js";
import { issueService } from "../../../services/issues.js";
import { randomUUID } from "node:crypto";
import {
  issueTreeControlService,
  isVerifiedIssueTreeControlInteractionWake,
  ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
} from "../../../services/issue-tree-control.js";
import {
  continuationSummaryParksExecutor,
  getIssueContinuationSummaryDocument,
} from "../../../services/issue-continuation-summary.js";
import { parseIssueExecutionState } from "../../../services/issue-execution-policy.js";
import { decideQueuedRunStaleness, decideScheduledRetryGate } from "../domain/policy.js";
// myrmidon(OPE-11947): the age of a queued run counts from when it began to wait
import { queuedRunWaitingSince } from "../domain/queued-run-age.js";
// myrmidon(P2): pending interaction addressee wake
import { isOwnerExplainWake, isPendingInteractionAddresseeWake } from "../myrmidon-pending-interaction-wake.js";
// myrmidon(RUN-GUARD-ESCALATE): the manager's wake after a final run guard stop is not the assignee's.
import {
  RUN_GUARD_STOP_NEEDS_INPUT_SOURCE,
  RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON,
  isRunGuardStopWakeRecipient,
} from "../../../myrmidon/run-guard-escalation.js";
import type {
  QueuedRunFacts,
  QueuedRunStalenessErrorCode,
  ReviewParticipantFacts,
  RetryReasonKind,
  ScheduledRetryFacts,
} from "../domain/policy.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  allowsIssueInteractionWake,
  deriveCommentId,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
} from "../domain/wake-context.js";
import type {
  CancelStaleQueuedRunInput,
  DispatchResolvedInteractionInput,
  DispatchResolvedInteractionOutcome,
  DueRetryRun,
  EvaluateScheduledRetryGateInput,
  ListDueRetriesInput,
  PromoteOrCancelDueRetryInput,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "../application/ports.js";
import type {
  CancelStaleQueuedRunOutcome,
  PostCommitEffect,
  PromoteScheduledRetryOutcome,
} from "../application/types.js";
import { RunDispatchApplicationError } from "../application/types.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type LoadGateFactsInput = {
  conversationContinuation: boolean;
  runId: string;
  companyId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
  retryReasonOverride?: string | null;
  wakeupRequestId: string | null;
};
type LoadGateFactsResult =
  | { agentFound: true; facts: ScheduledRetryFacts }
  | { agentFound: false; issueId: string | null };
type LoadStalenessFactsInput = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
  invocationSource: string;
};
type CancelSuppressedRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
  reason: string;
  errorCode: string;
  issueId: string | null;
  details: Record<string, unknown>;
};
type CancelSuppressedRetryResult = { applied: true; run: HeartbeatRun } | { applied: false };

/**
 * myrmidon(EMPTY-RUNS-6): the wait reason the start sweep writes onto a queued
 * run when the agent's own concurrency ceiling is full (`writeQueuedRunWaitReason`
 * in services/heartbeat.ts, the `availableSlots <= 0` branch of
 * `startNextQueuedRunForAgent`). Keep the two literals equal.
 */
const QUEUED_RUN_OWN_SLOT_WAIT_REASON = "agent_concurrency";

const NO_REVIEW_PARTICIPANT: ReviewParticipantFacts = {
  isInReview: false,
  hasParticipant: false,
  participantIsAgent: false,
  participantAgentId: null,
  currentStageType: null,
  currentParticipant: null,
};

// myrmidon(UNBLOCK-OWNER-WAKE): agent ids recorded as the owner of an issue's block.
export function blockOwnerAgentIds(blockerMetadata: unknown, unblockDescriptor: unknown): string[] {
  const ids: string[] = [];
  for (const holder of [blockerMetadata, unblockDescriptor]) {
    const owner = parseObject(holder).owner;
    const agentId = readNonEmptyString(parseObject(owner).agentId);
    if (agentId && !ids.includes(agentId)) ids.push(agentId);
  }
  return ids;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function classifyRetryReasonKind(
  retryReason: string | null,
  contextSnapshot?: Record<string, unknown> | null,
): RetryReasonKind {
  // myrmidon(OPE-11947): the scheduler marks the retry of a model-unavailable run.
  if (contextSnapshot?.modelUnavailableRetry === true) return "model_unavailable_wait";
  if (retryReason === MAX_TURN_CONTINUATION_RETRY_REASON) return "max_turn_continuation";
  if (retryReason === ISSUE_DISPOSITION_REPAIR_RETRY_REASON) return "disposition_repair";
  if (retryReason === "ai_connection_busy") return "ai_connection_wait";
  if (retryReason === "native_safe_replacement") return "native_safe_replacement";
  return "other";
}

function buildReviewParticipantFacts(input: {
  isInReview: boolean;
  executionState: ReturnType<typeof parseIssueExecutionState>;
}): ReviewParticipantFacts {
  const currentParticipant = input.executionState?.currentParticipant ?? null;
  return {
    isInReview: input.isInReview,
    hasParticipant: currentParticipant !== null,
    participantIsAgent: currentParticipant?.type === "agent",
    participantAgentId:
      currentParticipant?.type === "agent" ? (currentParticipant.agentId ?? null) : null,
    currentStageType: input.executionState?.currentStageType ?? null,
    currentParticipant: currentParticipant as Record<string, unknown> | null,
  };
}

function queuedEffect(run: HeartbeatRun): PostCommitEffect {
  return {
    kind: "run_queued",
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    wakeupRequestId: run.wakeupRequestId,
  };
}

function statusEffect(run: HeartbeatRun, previousStatus: string | null): PostCommitEffect {
  return {
    kind: "run_status_published",
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    error: run.error,
    errorCode: run.errorCode,
    contextSource: readNonEmptyString(parseObject(run.contextSnapshot).source),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    result: parseObject(run.resultJson),
    issueId: readNonEmptyString(parseObject(run.contextSnapshot).issueId),
    previousStatus,
  };
}

export function createPostgresRunDispatchAdapter(
  db: Db,
): ScheduledRetryReader & RunDispatchWriter {
  const budgets = budgetService(db);
  const treeControlSvc = issueTreeControlService(db);
  const issuesSvc = issueService(db);
  const runEventSink: RunEventSink = createPostgresRunEventSink();

  async function withIssueThenRunLocks<T>(
    input: { runId: string; companyId: string },
    onMissing: () => T,
    operation: (tx: Db, run: HeartbeatRun) => Promise<T>,
  ): Promise<T> {
    // Queue editing and claiming already use issue -> wake -> run. Read the
    // immutable issue reference without a lock first, then acquire issue ->
    // run here as well. Locking the run first can deadlock with a claimant
    // that owns the issue lock and is waiting for the run.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const hint = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!hint) return onMissing();
      const hintedIssueId = readNonEmptyString(parseObject(hint.contextSnapshot).issueId);

      const result: { kind: "missing" | "retry" } | { kind: "value"; value: T } =
        await db.transaction(async (tx) => {
          const typedTx = tx as unknown as Db;
          if (hintedIssueId) {
            await typedTx
              .select({ id: issues.id })
              .from(issues)
              .where(and(eq(issues.id, hintedIssueId), eq(issues.companyId, input.companyId)))
              .for("update");
          }

          const run = await typedTx
            .select()
            .from(heartbeatRuns)
            .where(
              and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)),
            )
            // Keep the run status stable through the semantic decision and any
            // resulting mutation and synchronous dispatch handoff. Never await
            // adapter-owned work while this transaction holds the row locks.
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!run) return { kind: "missing" as const };

          const lockedIssueId = readNonEmptyString(parseObject(run.contextSnapshot).issueId);
          if (lockedIssueId !== hintedIssueId) return { kind: "retry" as const };
          return { kind: "value" as const, value: await operation(typedTx, run) };
        });

      if (result.kind === "missing") return onMissing();
      if (result.kind === "value") return result.value;
    }

    throw new Error(
      `run-dispatch: run ${input.runId} changed issue context repeatedly while acquiring locks`,
    );
  }

  async function loadGateFacts(
    input: LoadGateFactsInput,
    now: Date,
    tx?: unknown,
  ): Promise<LoadGateFactsResult> {
    // Semantic adapter operations pass their transaction here so the fact
    // read and the state transition share one unit of work. This helper is
    // deliberately not exposed through the module's public API.
    const dbOrTx = (tx as Db | undefined) ?? db;
    const budgetsForRead = tx ? budgetService(dbOrTx) : budgets;
    const treeControlForRead = tx ? issueTreeControlService(dbOrTx) : treeControlSvc;
    const issuesSvcForRead = tx ? issueService(dbOrTx) : issuesSvc;

    const agent = await dbOrTx
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) {
      return { agentFound: false, issueId: readNonEmptyString(input.contextSnapshot.issueId) };
    }

    const retryReason =
      input.retryReasonOverride ??
      readNonEmptyString(input.contextSnapshot.retryReason) ??
      input.scheduledRetryReason ??
      null;
    const issueId = readNonEmptyString(input.contextSnapshot.issueId);
    const retryReasonKind = classifyRetryReasonKind(retryReason, input.contextSnapshot);

    // Facts fill in through the same rule order `decideScheduledRetryGate`
    // evaluates. A field still awaiting its own read keeps a value that
    // rule never blocks on, EXCEPT `issueFound`, which starts unresolved
    // and gets an explicit early check once the issue read lands — a
    // false default there would look exactly like "the issue is gone" the
    // moment `issueId` is set, before the read that would prove it. Once a
    // group of fields is real, this calls the gate on the facts gathered
    // so far, so a rule an earlier read already decided stops the run
    // before it pays for a later, unrelated read — a sweep of many due
    // retries must not query pause holds or dependencies for a retry a
    // budget block or a stale assignment already suppresses.
    const facts: ScheduledRetryFacts = {
      runId: input.runId,
      runAgentId: input.agentId,
      issueId,
      retryReasonKind,
      enforceIssueExecutionLock: retryReasonKind === "max_turn_continuation" || retryReasonKind === "ai_connection_wait",
      isNonAssigneeWorkspaceBusyRetry: isNonAssigneeWorkspaceBusyRetry(retryReason, input.contextSnapshot),
      budgetBlock: null,
      agentInvokable: true,
      agentInvokabilityDetails: {},
      agentInvokabilityInvalidOrgChain: false,
      heartbeatWakeOnDemandEnabled: true,
      issueFound: false,
      issueStatus: null,
      issueAssigneeAgentId: null,
      issueExecutionRunId: null,
      reviewParticipant: NO_REVIEW_PARTICIPANT,
      activePauseHold: null,
      dependenciesBlocked: null,
      dispositionRepair: null,
    };
    const isBlocked = () => !decideScheduledRetryGate(facts, now).allowed;

    const budgetBlock = await budgetsForRead.getInvocationBlock(input.companyId, input.agentId, {
      issueId,
      projectId: readNonEmptyString(input.contextSnapshot.projectId),
    });
    facts.budgetBlock = budgetBlock
      ? { reason: budgetBlock.reason, scopeType: budgetBlock.scopeType, scopeId: budgetBlock.scopeId }
      : null;
    if (facts.budgetBlock) return { agentFound: true, facts };

    const agentInvokability = await evaluateAgentInvokabilityFromDb(dbOrTx, agent);
    facts.agentInvokable = agentInvokability.invokable;
    facts.agentInvokabilityDetails = agentInvokability.invokable ? {} : agentInvokability.details;
    facts.agentInvokabilityInvalidOrgChain = agentInvokability.invokable
      ? false
      : agentInvokability.invalidOrgChain;
    if (!facts.agentInvokable) return { agentFound: true, facts };

    facts.heartbeatWakeOnDemandEnabled = isHeartbeatWakeOnDemandEnabled(agent);
    if (!facts.heartbeatWakeOnDemandEnabled) return { agentFound: true, facts };

    if (!issueId) return { agentFound: true, facts };

    const issueQuery = dbOrTx
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        // myrmidon(HUMAN-REVIEW-WAIT): read for collectDispositionRepairSourceState below.
        reviewPolicy: issues.reviewPolicy,
        hiddenAt: issues.hiddenAt,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
    // Locking the row here, only when a caller opened a transaction for the
    // promote-or-cancel write, is what makes that write's decision hold: a
    // concurrent reassignment, pause, or status change blocks on this lock
    // instead of landing between this read and that write.
    const issue = await (tx ? issueQuery.for("update") : issueQuery).then(
      (rows) => rows[0] ?? null,
    );

    facts.issueFound = issue !== null;
    if (!facts.issueFound) return { agentFound: true, facts };

    facts.issueStatus = issue.status;
    facts.issueAssigneeAgentId = issue.assigneeAgentId;
    facts.issueExecutionRunId = issue.executionRunId;
    facts.issueCheckoutRunId = issue.checkoutRunId;
    // myrmidon(1.6.5 F-09): a hidden issue is not startable.
    facts.issueHiddenAt = issue.hiddenAt;
    if (input.conversationContinuation) {
      const [interactions, linkedApprovals] = await Promise.all([
        dbOrTx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.issueId, issueId), eq(issueThreadInteractions.status, "pending"),
        )).limit(1),
        dbOrTx.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
          eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, issueApprovals.companyId),
        )).where(and(
          eq(issueApprovals.companyId, input.companyId), eq(issueApprovals.issueId, issueId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        )).limit(1),
      ]);
      facts.pendingResponse = interactions.length > 0 ? "interaction" : linkedApprovals.length > 0 ? "approval" : null;
    }
    facts.reviewParticipant = buildReviewParticipantFacts({
      isInReview: issue.status === "in_review",
      executionState: parseIssueExecutionState(issue.executionState),
    });

    // The gate checks a disposition repair's own supersession before it
    // checks ownership or status, so this read must land before the next
    // isBlocked() call — checking isBlocked() first would report the wrong
    // suppression reason for a superseded repair.
    if (retryReasonKind === "disposition_repair") {
      const expectedFingerprint = readNonEmptyString(input.contextSnapshot.dispositionRepairFingerprint);
      const sourceState = await collectDispositionRepairSourceState(dbOrTx, {
        issue,
        excludeRunId: input.runId,
        excludeWakeupRequestId: input.wakeupRequestId,
      });
      facts.dispositionRepair = {
        expectedFingerprintPresent: expectedFingerprint !== null,
        fingerprintMatches: sourceState.fingerprint === expectedFingerprint,
        hasActiveExecutionPath: sourceState.hasActiveExecutionPath,
        hasDurableWaitingPath: sourceState.hasDurableWaitingPath,
        expectedFingerprint,
        currentFingerprint: sourceState.fingerprint,
        durablePathReason: sourceState.durablePathReason,
      };
    }
    if (isBlocked()) return { agentFound: true, facts };

    const activePauseHold = await treeControlForRead.getActivePauseHoldGate(input.companyId, issueId);
    facts.activePauseHold = activePauseHold
      ? { holdId: activePauseHold.holdId, rootIssueId: activePauseHold.rootIssueId }
      : null;
    if (isBlocked()) return { agentFound: true, facts };

    const dependencyReadiness = await issuesSvcForRead.listDependencyReadiness(input.companyId, [issueId]);
    const readiness = dependencyReadiness.get(issueId);
    facts.dependenciesBlocked =
      readiness && !readiness.isDependencyReady
        ? {
            unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
            unresolvedBlockerCount: readiness.unresolvedBlockerCount,
          }
        : null;

    return { agentFound: true, facts };
  }

  async function evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!run) {
      throw new RunDispatchApplicationError(
        "run_not_found",
        `run-dispatch: run ${input.runId} was not found while evaluating retry eligibility`,
      );
    }
    const factsResult = await loadGateFacts(
      {
        runId: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        conversationContinuation: run.runtimeMode === "legacy" && hasConversationContinuationPolicy(run.resultJson),
        contextSnapshot: parseObject(run.contextSnapshot),
        scheduledRetryReason: run.scheduledRetryReason,
        retryReasonOverride: input.retryReasonOverride,
        wakeupRequestId: run.wakeupRequestId,
      },
      input.now,
    );
    if (!factsResult.agentFound) {
      return {
        allowed: false as const,
        reason: "Scheduled retry suppressed because the agent no longer exists",
        errorCode: "agent_not_invokable" as const,
        issueId: factsResult.issueId,
        details: { agentId: run.agentId },
      };
    }
    return decideScheduledRetryGate(factsResult.facts, input.now);
  }

  async function listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]> {
    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "scheduled_retry"),
          lte(heartbeatRuns.scheduledRetryAt, input.now),
          input.cutoff ? gte(heartbeatRuns.createdAt, input.cutoff) : undefined,
        ),
      )
      .orderBy(
        asc(heartbeatRuns.scheduledRetryAt),
        asc(heartbeatRuns.createdAt),
        asc(heartbeatRuns.id),
      )
      .limit(input.limit);

    return rows.map((row) => ({
      runId: row.id,
      companyId: row.companyId,
    }));
  }

  async function loadStalenessFacts(
    input: LoadStalenessFactsInput,
    _now: Date,
    tx?: unknown,
  ): Promise<QueuedRunFacts> {
    const dbOrTx = (tx as Db | undefined) ?? db;
    const issueId = input.issueId;
    const context = input.contextSnapshot;

    const issueQuery = dbOrTx
      .select({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
        executionState: issues.executionState,
        hiddenAt: issues.hiddenAt,
        blockerMetadata: issues.blockerMetadata,
        unblockDescriptor: issues.unblockDescriptor,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
    const issue = await (tx ? issueQuery.for("update") : issueQuery).then(
      (rows) => rows[0] ?? null,
    );

    const wakeCommentId = deriveCommentId(context);
    const isInteractionWake = allowsIssueInteractionWake(
      context,
      ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
    );
    // myrmidon(P2): a pending interaction wakes its addressee, who may not be the assignee
    // myrmidon(1.6.5-OWNER-VIA-BOT): the wake that asks the AUTHOR of an owner decision to explain it
    // to the owner gets the same bypass: the author is not the addressee and not always the assignee
    const ownerWakeFacts = {
      companyId: input.companyId,
      issueId,
      agentId: input.agentId,
      contextSnapshot: context,
    };
    const pendingInteractionAddresseeWake =
      (await isPendingInteractionAddresseeWake(dbOrTx, ownerWakeFacts)) ||
      (await isOwnerExplainWake(dbOrTx, ownerWakeFacts));
    const resumeIntent = context.resumeIntent === true || context.followUpRequested === true;
    const wakeReason = readNonEmptyString(context.wakeReason);
    const retryReason =
      readNonEmptyString(context.retryReason) ?? input.scheduledRetryReason ?? null;
    const interactionResolvedAt = readNonEmptyString(context.interactionResolvedAt);
    const hasResolvedInteractionEvidence =
      interactionResolvedAt !== null && !Number.isNaN(Date.parse(interactionResolvedAt));
    const isResolvedInteractionContinuation = isResolvedInteractionContinuationWakeContext(context);

    const continuationParkApplies = Boolean(
      issue &&
        issue.status === "in_progress" &&
        !wakeCommentId &&
        !hasResolvedInteractionEvidence &&
        (wakeReason === "issue_continuation_needed" || retryReason === "issue_continuation_needed"),
    );
    let continuationSummaryBody: string | null = null;
    let continuationParksExecutor = false;
    if (continuationParkApplies) {
      const queuedWake = parseObject(context.paperclipWake);
      const queuedContinuationSummary =
        readNonEmptyString(parseObject(context.paperclipContinuationSummary).body) ??
        readNonEmptyString(parseObject(queuedWake.continuationSummary).body);
      const currentContinuationSummary = queuedContinuationSummary
        ? null
        : await getIssueContinuationSummaryDocument(dbOrTx, issueId);
      continuationSummaryBody = queuedContinuationSummary ?? currentContinuationSummary?.body ?? null;
      continuationParksExecutor = continuationSummaryParksExecutor(continuationSummaryBody);
    }

    const recoveryActionId = readNonEmptyString(context.recoveryActionId);
    const isAuthorizedSourceScopedRecovery =
      issue && wakeReason === "source_scoped_recovery_action" && recoveryActionId
        ? await dbOrTx
            .select({ id: issueRecoveryActions.id })
            .from(issueRecoveryActions)
            .where(
              and(
                eq(issueRecoveryActions.id, recoveryActionId),
                eq(issueRecoveryActions.companyId, input.companyId),
                eq(issueRecoveryActions.sourceIssueId, issue.id),
                eq(issueRecoveryActions.ownerAgentId, input.agentId),
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
              ),
            )
            .limit(1)
            .then((rows) => Boolean(rows[0]))
        : false;
    // Recovery-created continuation runs may legitimately execute for a prior assignee.
    // Bind this bypass to the exact automation source and continuation reason.
    const isProductiveContinuationRecovery = Boolean(
      issue &&
        input.invocationSource === "automation" &&
        context.source === "issue.productive_terminal_continuation_recovery" &&
        wakeReason === "issue_continuation_needed" &&
        retryReason === "issue_continuation_needed",
    );

    // myrmidon(RUN-GUARD-ESCALATE): the wake that tells the assignee's manager a task
    // was stopped for good by the run guard. Bound to the exact automation source and
    // wake reason, to the issue being `blocked` (the state the stop left it in) and to
    // the run's agent being the assignee's `reports_to` or the agent `adm`: a stranger
    // agent, or a task that has moved on, gets no bypass and is cancelled as before.
    const isRunGuardStopNeedsInputWake = Boolean(
      issue &&
        issue.status === "blocked" &&
        input.invocationSource === "automation" &&
        context.source === RUN_GUARD_STOP_NEEDS_INPUT_SOURCE &&
        wakeReason === RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON &&
        (await isRunGuardStopWakeRecipient(dbOrTx, {
          companyId: input.companyId,
          assigneeAgentId: issue.assigneeAgentId,
          agentId: input.agentId,
        })),
    );

    // myrmidon(UNBLOCK-OWNER-WAKE): `issue_unblock_requested` wakes the owner of the
    // block (stranded disposition, routable blocked) to resolve it; that owner is
    // usually not the assignee. Bound to the automation wake reason, the issue still
    // being blocked and the run's agent being the recorded block owner.
    const isUnblockOwnerWake = Boolean(
      issue &&
        issue.status === "blocked" &&
        input.invocationSource === "automation" &&
        wakeReason === "issue_unblock_requested" &&
        blockOwnerAgentIds(issue.blockerMetadata, issue.unblockDescriptor).includes(input.agentId),
    );

    // myrmidon(OPE-11948): an automatic continuation wake — the system's own
    // `issue_continuation_needed`, not a person's comment, a resume request or
    // an interaction answer (a card a person resolved keeps its own rules) — is
    // only started while the issue is actionable.
    const isAutomaticContinuationWake = Boolean(
      input.invocationSource === "automation" &&
        wakeReason === "issue_continuation_needed" &&
        !wakeCommentId &&
        !resumeIntent &&
        !isInteractionWake &&
        !pendingInteractionAddresseeWake &&
        !isResolvedInteractionContinuation &&
        !readNonEmptyString(context.interactionId),
    );

    const retryReasonKind = classifyRetryReasonKind(retryReason);
    // Dependency edges can change after scheduled promotion without changing
    // the displayed status. Read them again under the queued/final issue lock.
    const readiness = issue && retryReasonKind === "native_safe_replacement"
      ? (await issueService(dbOrTx).listDependencyReadiness(input.companyId, [issueId])).get(issueId)
      : null;
    return {
      runId: input.runId,
      runAgentId: input.agentId,
      issueId,
      retryReasonKind,
      dependenciesBlocked: readiness && !readiness.isDependencyReady ? {
        unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
        unresolvedBlockerCount: readiness.unresolvedBlockerCount,
      } : null,
      issueFound: issue !== null,
      issueStatus: issue?.status ?? null,
      issueAssigneeAgentId: issue?.assigneeAgentId ?? null,
      issueExecutionRunId: issue?.executionRunId ?? null,
      issueCheckoutRunId: issue?.checkoutRunId ?? null,
      issueHiddenAt: issue?.hiddenAt ?? null,
      isResolvedInteractionContinuation,
      isConnectionContinuation: (isResolvedInteractionContinuation && context.interactionKind === "connection_intent")
        || context.source === "connection_tools.refreshed",
      isInteractionWake,
      // myrmidon(P2): pending interaction addressee wake
      isPendingInteractionAddresseeWake: pendingInteractionAddresseeWake,
      isAuthorizedSourceScopedRecovery,
      isProductiveContinuationRecovery,
      isRunGuardStopNeedsInputWake,
      isUnblockOwnerWake,
      isAutomaticContinuationWake,
      isNonAssigneeWorkspaceBusyRetry: isNonAssigneeWorkspaceBusyRetry(retryReason, context),
      resumeIntent,
      wakeCommentIdPresent: Boolean(wakeCommentId),
      continuationParkApplies,
      continuationParksExecutor,
      continuationSummaryBody,
      wakeReason,
      retryReason,
      reviewParticipant: issue
        ? buildReviewParticipantFacts({
            isInReview: issue.status === "in_review",
            executionState: issue.status === "in_review" ? parseIssueExecutionState(issue.executionState) : null,
          })
        : NO_REVIEW_PARTICIPANT,
    };
  }

  async function promoteDueRetryInTx(
    tx: Db,
    input: PromoteOrCancelDueRetryInput,
  ): Promise<
    | { applied: true; run: HeartbeatRun; postCommitEffects: PostCommitEffect[] }
    | { applied: false }
  > {
    const [row] = await tx
      .update(heartbeatRuns)
      .set({ status: "queued", updatedAt: input.now })
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          lte(heartbeatRuns.scheduledRetryAt, input.now),
        ),
      )
      .returning();
    if (!row) return { applied: false };

    await runEventSink.commitRunEvent(
      tx as unknown as Db,
      scheduledRetryPromotedEventCommand({
        companyId: row.companyId,
        runId: row.id,
        agentId: row.agentId,
        scheduledRetryAttempt: row.scheduledRetryAttempt,
        scheduledRetryAt: row.scheduledRetryAt,
        scheduledRetryReason: row.scheduledRetryReason,
      }),
    );

    return { applied: true as const, run: row, postCommitEffects: [queuedEffect(row)] };
  }

  async function cancelSuppressedRetryInTx(
    tx: Db,
    input: CancelSuppressedRetryInput,
  ): Promise<CancelSuppressedRetryResult> {
    const [row] = await tx
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: input.now,
        error: input.reason,
        errorCode: input.errorCode,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          lte(heartbeatRuns.scheduledRetryAt, input.now),
        ),
      )
      .returning();
    if (!row) return { applied: false };

    if (row.wakeupRequestId) {
      await tx
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt: input.now, error: input.reason, updatedAt: input.now })
        .where(
          and(
            eq(agentWakeupRequests.id, row.wakeupRequestId),
            eq(agentWakeupRequests.companyId, row.companyId),
          ),
        );
    }

    if (input.issueId) {
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(issues.companyId, row.companyId),
            eq(issues.id, input.issueId),
            eq(issues.executionRunId, row.id),
          ),
        );
    }

    await runEventSink.commitRunEvent(
      tx as unknown as Db,
      scheduledRetrySuppressedEventCommand(
        {
          companyId: row.companyId,
          runId: row.id,
          agentId: row.agentId,
          scheduledRetryAttempt: row.scheduledRetryAttempt,
          scheduledRetryAt: row.scheduledRetryAt,
          scheduledRetryReason: row.scheduledRetryReason,
        },
        { reason: input.reason, details: input.details },
      ),
    );

    return { applied: true, run: row };
  }

  async function promoteOrCancelDueRetry(
    input: PromoteOrCancelDueRetryInput,
  ): Promise<PromoteScheduledRetryOutcome> {
    const now = input.now;

    const promoteLockedRun = async (tx: Db, run: HeartbeatRun) => {
      if (
        run.status !== "scheduled_retry" ||
        !run.scheduledRetryAt ||
        new Date(run.scheduledRetryAt).getTime() > now.getTime()
      ) {
        return { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
      }
      const factsResult = await loadGateFacts(
        {
          runId: run.id,
          companyId: run.companyId,
          agentId: run.agentId,
          conversationContinuation: run.runtimeMode === "legacy" && hasConversationContinuationPolicy(run.resultJson),
          contextSnapshot: parseObject(run.contextSnapshot),
          scheduledRetryReason: run.scheduledRetryReason,
          retryReasonOverride: run.scheduledRetryReason,
          wakeupRequestId: run.wakeupRequestId,
        },
        now,
        tx,
      );

      if (!factsResult.agentFound) {
        const cancelled = await cancelSuppressedRetryInTx(tx as unknown as Db, {
          runId: input.runId,
          companyId: input.companyId,
          now,
          reason: "Scheduled retry suppressed because the agent no longer exists",
          errorCode: "agent_not_invokable",
          issueId: factsResult.issueId,
          details: { agentId: run.agentId },
        });
        return cancelled.applied
          ? {
              outcome: {
                outcome: "gate_suppressed" as const,
                reason: "Scheduled retry suppressed because the agent no longer exists",
                errorCode: "agent_not_invokable" as const,
              },
              telemetryRun: cancelled.run,
            }
          : { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
      }

      const gate = decideScheduledRetryGate(factsResult.facts, now);

      // Preserve legacy transient retry behavior for runs that only carry a
      // loose task context rather than a persisted issue row: a missing
      // issue suppresses a max-turn continuation, but every other retry
      // reason proceeds to promotion anyway.
      const isLegacyMissingIssueException =
        !hasConversationContinuationPolicy(run.resultJson) &&
        !gate.allowed &&
        gate.errorCode === "issue_not_found" &&
        factsResult.facts.retryReasonKind !== "max_turn_continuation" &&
        factsResult.facts.retryReasonKind !== "native_safe_replacement" &&
        factsResult.facts.retryReasonKind !== "model_unavailable_wait";

      if (!gate.allowed && !isLegacyMissingIssueException) {
        const cancelled = await cancelSuppressedRetryInTx(tx as unknown as Db, {
          runId: input.runId,
          companyId: input.companyId,
          now,
          reason: gate.reason,
          errorCode: gate.errorCode,
          issueId: gate.issueId,
          details: gate.details,
        });
        return cancelled.applied
          ? {
              outcome: {
                outcome: "gate_suppressed" as const,
                reason: gate.reason,
                errorCode: gate.errorCode,
              },
              telemetryRun: cancelled.run,
            }
          : { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
      }

      const promoted = await promoteDueRetryInTx(tx as unknown as Db, {
        runId: input.runId,
        companyId: input.companyId,
        now,
      });
      return promoted.applied
        ? {
            outcome: {
              outcome: "promoted" as const,
              postCommitEffects: promoted.postCommitEffects,
            },
            telemetryRun: null,
          }
        : { outcome: { outcome: "not_promoted" as const }, telemetryRun: null };
    };
    const transactionResult = await withIssueThenRunLocks(
      input,
      () => ({ outcome: { outcome: "not_promoted" as const }, telemetryRun: null }),
      promoteLockedRun,
    );

    // Telemetry is best-effort background work; fire it only after the
    // transaction above has committed, so a suppressed retry is never
    // published before its cancellation is durable, and never published at
    // all if the transaction rolled back.
    if (transactionResult.telemetryRun) {
      void emitAgentTaskRun(db, transactionResult.telemetryRun);
    }

    return transactionResult.outcome;
  }

  async function cancelStaleRunInTx(
    tx: Db,
    run: HeartbeatRun,
    issueId: string | null,
    decision: {
      stale: true;
      errorCode: QueuedRunStalenessErrorCode;
      reason: string;
      details: Record<string, unknown>;
    },
    expectedStatus: "queued" | "running",
    now: Date,
  ): Promise<CancelStaleQueuedRunOutcome> {
      const [row] = await tx
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: decision.reason,
          errorCode: decision.errorCode,
          resultJson: {
            ...parseObject(run.resultJson),
            stopReason: decision.errorCode,
            ...(decision.errorCode === "execution_reconciliation_required"
              ? { executionWait: decision.details }
              : {}),
            effectiveTimeoutSec: 0,
            timeoutConfigured: false,
            timeoutSource: "stale_queued_run_gate",
            timeoutFired: false,
            failedBeforeModel: true,
            failed_before_model: true,
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.companyId, run.companyId),
            eq(heartbeatRuns.status, expectedStatus),
          ),
        )
        .returning();
      // A concurrent claimant or canceller already moved the run off
      // `expectedStatus`: the caller's staleness decision lost the race, so
      // this write must not overwrite whatever status won it.
      if (!row) return { outcome: "lost_race" };

      if (row.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "skipped", finishedAt: now, error: decision.reason, updatedAt: now })
          .where(
            and(
              eq(agentWakeupRequests.id, row.wakeupRequestId),
              eq(agentWakeupRequests.companyId, row.companyId),
            ),
          );

        // myrmidon(WAKE-STALL-ROOT-A): a wake skipped because execution
        // reconciliation is required is not terminal — after the
        // reconciliation commit, re-enqueue it once (new idempotency key,
        // parent = the skipped record, resurrection_count < 1, and never
        // when the recovery evidence blocks replay).
        if (decision.errorCode === "execution_reconciliation_required") {
          const originalWakeup = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.id, row.wakeupRequestId),
                eq(agentWakeupRequests.companyId, row.companyId),
              ),
            )
            .then(rows => rows[0]);

          const payload = parseObject(originalWakeup?.payload);
          const evidence = parseObject(
            (payload as Record<string, unknown> | null)?.evidence,
          );
          const replayBlocked =
            parseObject(evidence.automaticRecovery).replay === "blocked";
          // The parked intent must carry the issue scope: every serving path
          // (release drain, stranded-wake reconcile, terminal cleanup) reads
          // `payload ->> 'issueId'`. A resurrection without it could never be
          // served or cleaned up, so it is not created at all.
          const wakeIssueId =
            readNonEmptyString((payload as Record<string, unknown> | null)?.issueId) ?? issueId;

          if (
            originalWakeup &&
            (originalWakeup.resurrectionCount ?? 0) < 1 &&
            !replayBlocked &&
            wakeIssueId
          ) {
            // myrmidon(WAKE-STALL-ROOT-A): park as ordinary deferred queue
            // input — `deferred_issue_execution` scoped by
            // `payload ->> 'issueId'`, WITHOUT an `executionWait` marker. A
            // bare `pending` row is read by no scheduler, so the wake
            // stranded and the agent idled; an `executionWait` row is
            // intentionally exempt from the stranded-wake reconcile and
            // would strand again once the hold clears. Unmarked, the row is
            // served by the existing bounded paths: the release drain
            // promotes it through full admission once the lock is free, the
            // stranded-wake reconcile cancels it on a terminal task or
            // expires it after 30 minutes and re-wakes the agent. A hold
            // that re-appears at promotion time skips this row terminally
            // (its resurrection_count is already 1), so the loop stays
            // bounded.
            await tx
              .insert(agentWakeupRequests)
              .values({
                id: randomUUID(),
                companyId: originalWakeup.companyId,
                agentId: originalWakeup.agentId,
                source: originalWakeup.source,
                triggerDetail: originalWakeup.triggerDetail,
                reason: "resurrection_execution_reconciliation_required",
                payload: {
                  ...(payload as Record<string, unknown> | null),
                  issueId: wakeIssueId,
                },
                status: "deferred_issue_execution",
                requestedByActorType: originalWakeup.requestedByActorType,
                requestedByActorId: originalWakeup.requestedByActorId,
                idempotencyKey: `${originalWakeup.idempotencyKey ?? originalWakeup.id}:resurrection:${randomUUID()}`,
                resurrectionCount: (originalWakeup.resurrectionCount ?? 0) + 1,
                createdAt: now,
                updatedAt: now,
              });
          }
        }
      }

      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.companyId, row.companyId),
              eq(issues.id, issueId),
              eq(issues.executionRunId, row.id),
            ),
          );
      }

      await runEventSink.commitRunEvent(
        tx as unknown as Db,
        staleQueuedRunCancelledEventCommand(
          { companyId: row.companyId, runId: row.id, agentId: row.agentId },
          decision,
        ),
      );
      return {
        outcome: "cancelled",
        reason: decision.reason,
        errorCode: decision.errorCode,
        postCommitEffects: [statusEffect(row, expectedStatus)],
      };
  }

  // myrmidon(OPE-12577): the wake of the assignee's manager after a final run guard
  // stop does not continue the assignee's execution. The stopped run keeps its
  // environment lease for a moment after the stop, and that execution hold
  // (execution_owner_active) must not make the manager's queued run stale: it was
  // cancelled as execution_reconciliation_required and the task stayed blocked.
  // Bound like isRunGuardStopNeedsInputWake: exact source and reason, a blocked
  // issue, the run's agent being the assignee's reports_to or `adm`.
  async function isRunGuardStopManagerRun(
    tx: Db,
    run: HeartbeatRun,
    contextSnapshot: Record<string, unknown>,
    issueId: string,
  ): Promise<boolean> {
    if (run.invocationSource !== "automation") return false;
    if (contextSnapshot.source !== RUN_GUARD_STOP_NEEDS_INPUT_SOURCE) return false;
    if (readNonEmptyString(contextSnapshot.wakeReason) !== RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON) return false;
    const [issue] = await tx
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)))
      .limit(1);
    if (!issue || issue.status !== "blocked") return false;
    return isRunGuardStopWakeRecipient(tx, {
      companyId: run.companyId,
      assigneeAgentId: issue.assigneeAgentId,
      agentId: run.agentId,
    });
  }

  async function decideCurrentRunStaleness(tx: Db, run: HeartbeatRun, now: Date) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    if (!issueId) return { issueId: null, facts: null, decision: { stale: false as const } };
    const recovery = (await isRunGuardStopManagerRun(tx, run, contextSnapshot, issueId))
      ? null
      : await getExecutionBlocker(tx, run.companyId, issueId, { conversationResetCommentId: deriveCommentId(contextSnapshot) });
    if (recovery) return { issueId, facts: null, decision: { stale: true as const,
      errorCode: "execution_reconciliation_required" as const, reason: recovery.nextAction,
      details: { issueId, recoveryActionId: recovery.recoveryActionId },
    } };
    const facts = await loadStalenessFacts(
      {
        runId: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        issueId,
        contextSnapshot,
        scheduledRetryReason: run.scheduledRetryReason,
        invocationSource: run.invocationSource,
      },
      now,
      tx,
    );
    return { issueId, facts, decision: decideQueuedRunStaleness(facts, now) };
  }

  // myrmidon(EMPTY-RUNS-6): is this queued run simply standing in its own
  // agent's queue? The start sweep names the wait on the run
  // (`contextSnapshot.waitReason = "agent_concurrency"`: the agent's own
  // concurrency ceiling is full), and the agent has a run in `running` right
  // now. Such a run is not stale by age: it starts when the agent's running run
  // ends. Expiring it bought nothing — the wake that follows the expiry queues
  // the same run behind the same ceiling — and after two expiries the rewake
  // throttle froze the task with "N runs without progress" although no run of
  // it had ever started (13.11: seven tasks assigned to one engineer at once,
  // two slots; 46 of 50 expiries in 72 h carried this wait reason). A named
  // ceiling without a running run behind it is a lost start, not a queue, and
  // expires as before.
  //
  // myrmidon(EMPTY-RUNS-6B): the same holds for the moment the slot frees. The
  // sweep that expires by age runs before the start sweep, so a run that waited
  // behind a run that has just finished was cancelled in the second the slot
  // opened (no run running any more) and a replacement with another wake reason
  // started instead. A wait for the agent's own slot is therefore counted from
  // the end of the agent's last started run when that is later than the start of
  // the wait: a slot freed just now leaves the age near zero, a slot free for the
  // whole threshold without the run starting is a lost start and expires.
  async function queuedRunWaitsForOwnAgentSlot(
    tx: Db,
    run: HeartbeatRun,
    now: Date,
    staleAfterMs: number,
  ): Promise<boolean> {
    const waitReason = readNonEmptyString(parseObject(run.contextSnapshot).waitReason);
    if (waitReason !== QUEUED_RUN_OWN_SLOT_WAIT_REASON) return false;
    const running = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.agentId, run.agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      )
      .limit(1);
    if (running.length > 0) return true;
    // Only a run that really held a slot counts (`started_at is not null`): a run
    // cancelled in the queue gets `finished_at = now` too and must not refresh
    // the protection. The `started_at` lower bound lets the index
    // (company_id, agent_id, started_at) serve the lookup; a run does not last
    // longer than a day, so a run that ended inside the window started within
    // a day before the window began. One row, no aggregate over the history.
    const waitingSince = queuedRunWaitingSince(run, now);
    const freedAfter = new Date(Math.max(waitingSince.getTime(), now.getTime() - staleAfterMs));
    const startedAfter = new Date(freedAfter.getTime() - 24 * 60 * 60 * 1000);
    const freed = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.agentId, run.agentId),
          ne(heartbeatRuns.id, run.id),
          isNotNull(heartbeatRuns.startedAt),
          gte(heartbeatRuns.startedAt, startedAfter),
          gt(heartbeatRuns.finishedAt, freedAfter),
        ),
      )
      .limit(1);
    return freed.length > 0;
  }

  // myrmidon(RESUME-AFTER-CANCEL): a queued run of an agent the operator has
  // paused waits for the resume, not for a slot. The age sweep cancelled it and
  // the replacement wake then failed with 409 "Agent is not invokable" (logged
  // at error level; 13.11 23:35, three runs), so nothing was left to continue
  // the task after the pause was lifted. Resuming the agent promotes its queued
  // runs (myrmidon/pause-drain.ts), which start with their own wake reason. The
  // task-state checks of the staleness decision still apply to such a run.
  async function queuedRunWaitsForAgentResume(tx: Db, run: HeartbeatRun): Promise<boolean> {
    const [agent] = await tx
      .select({ status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, run.companyId), eq(agents.id, run.agentId)))
      .limit(1);
    return agent?.status === "paused";
  }

  async function cancelStaleQueuedRun(
    input: CancelStaleQueuedRunInput,
  ): Promise<CancelStaleQueuedRunOutcome> {
    const cancelLockedRun = async (tx: Db, run: HeartbeatRun) => {
      if (run.status !== input.expectedStatus) return { outcome: "lost_race" as const };
      // myrmidon(OPE-11947): a promoted scheduled retry waits since its due time,
      // not since it was created (same measure as the sweep's selection).
      const staleAgeMs = input.now.getTime() - queuedRunWaitingSince(run, input.now).getTime();
      if (
        input.expectedStatus === "queued" &&
        input.staleAfterMs !== undefined &&
        input.staleAfterMs > 0 &&
        staleAgeMs >= input.staleAfterMs &&
        // myrmidon(EMPTY-RUNS-6): a run that stands in its own agent's queue is
        // not expired by age; the task-state checks below still apply to it.
        !(await queuedRunWaitsForOwnAgentSlot(tx, run, input.now, input.staleAfterMs)) &&
        !(await queuedRunWaitsForAgentResume(tx, run))
      ) {
        return cancelStaleRunInTx(
          tx,
          run,
          readNonEmptyString(parseObject(run.contextSnapshot).issueId),
          {
            stale: true,
            errorCode: "queued_run_stale_timeout",
            reason: `Cancelled because it remained queued for more than ${Math.round(input.staleAfterMs / 60000)} minutes without starting`,
            details: { staleAgeMs, staleAfterMs: input.staleAfterMs },
          },
          input.expectedStatus,
          input.now,
        );
      }
      const { issueId, facts, decision } = await decideCurrentRunStaleness(tx, run, input.now);
      if (!decision.stale || !issueId) {
        if (input.expectedStatus === "queued" && facts?.isInteractionWake) {
          // Preserve the authority accepted under the issue/run locks. Later
          // preflight reads can observe a reassignment; they must not turn an
          // assignee comment into a non-assignee subscription-wait exception.
          await tx.update(heartbeatRuns).set({
            runnerProfileJson: {
              ...parseObject(run.runnerProfileJson),
              aiConnectionNonAssigneeCommentWake: facts.issueAssigneeAgentId !== run.agentId,
            },
          }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
        }
        return { outcome: "not_stale" as const };
      }
      return cancelStaleRunInTx(tx, run, issueId, decision, input.expectedStatus, input.now);
    };

    return withIssueThenRunLocks(
      input,
      () => {
        throw new RunDispatchApplicationError(
          "run_not_found",
          `run-dispatch: run ${input.runId} disappeared during stale-run validation`,
        );
      },
      cancelLockedRun,
    );
  }

  async function dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>> {
    const dispatchLockedRun = async (tx: Db, run: HeartbeatRun) => {
      if (run.status !== input.expectedStatus) {
        return { dispatched: false as const, cancellation: { outcome: "lost_race" as const } };
      }
      const { issueId, decision: initialDecision } = await decideCurrentRunStaleness(
        tx,
        run,
        input.now,
      );
      const decision =
        !initialDecision.stale && issueId
          ? await tx
              .select({ executionRunId: issues.executionRunId })
              .from(issues)
              .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
              .then((rows) => rows[0] ?? null)
              .then((issue) =>
                issue?.executionRunId === run.id
                  ? initialDecision
                  : {
                      stale: true as const,
                      errorCode: "issue_execution_lock_changed" as const,
                      reason:
                        "Cancelled because continuation no longer owns the issue execution lock before adapter dispatch",
                      details: {
                        issueId,
                        expectedExecutionRunId: run.id,
                        currentExecutionRunId: issue?.executionRunId ?? null,
                      },
                    },
              )
          : initialDecision;

      if (decision.stale && issueId) {
        const cancellation = await cancelStaleRunInTx(
          tx,
          run,
          issueId,
          decision,
          input.expectedStatus,
          input.now,
        );
        return { dispatched: false as const, cancellation };
      }

      // Hand off while ownership is still locked, but do not await the provider
      // promise. Bootstrap and failure finalization can update these same rows;
      // the transaction must commit independently of either callback completing.
      const resultPromise = input.dispatch(() => {});
      // A synchronous rejection can precede the commit response. Observe it
      // immediately while preserving the original promise for the caller.
      void resultPromise.catch(() => {});
      return { dispatched: true as const, resultPromise };
    };

    return withIssueThenRunLocks(
      input,
      () => {
        throw new RunDispatchApplicationError(
          "run_not_found",
          `run-dispatch: run ${input.runId} disappeared before resolved-interaction dispatch`,
        );
      },
      dispatchLockedRun,
    );

  }

  return {
    evaluateScheduledRetryGate,
    listDueRetries,
    cancelStaleQueuedRun,
    dispatchResolvedInteractionIfCurrent,
    promoteOrCancelDueRetry,
  };
}
