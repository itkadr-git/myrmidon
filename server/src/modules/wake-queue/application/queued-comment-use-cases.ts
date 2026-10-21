import type { IssueComment } from "@paperclipai/shared";
import {
  decideQueuedCommentActorOwnsEntry,
  decideQueuedCommentReorder,
} from "../domain/policy.js";
// myrmidon(S5): queued comment edits are stored with secret values masked
import { maskSecretsInText } from "../../../myrmidon/secret-masking.js";
// myrmidon(1.6-GRD): prompt-injection flag on untrusted queued text (part B)
import {
  guardrailsInjectionEnabled,
  injectionScoreThreshold,
  wrapUntrusted,
  UNTRUSTED_DATA_CLOSE,
  UNTRUSTED_DATA_OPEN,
} from "../../../myrmidon/guardrails/injection.js";
// myrmidon(1.7-GRD-MODES): what a masked/blocked untrusted comment becomes
// in the RUN payload — the run sees the notice, never the flagged text.
const MASKED_UNTRUSTED_BODY = "[masked by guardrail: injection]";
const BLOCKED_UNTRUSTED_NOTICE =
  "[blocked by guardrail: injection — the text of this queued message was withheld from the run because it matched the prompt-injection detector; the operator can change the rule's mode in Company Settings → Guardrails]";
import type {
  QueuedCommentActivityPublication,
  QueuedCommentActor,
  QueuedCommentIssueContext,
  QueuedCommentIssueLockWriter,
  QueuedCommentQueueSnapshot,
  QueuedCommentQueueTransaction,
  QueuedCommentRunRow,
} from "./queued-comment-ports.js";

export type QueuedCommentMutationErrorCode =
  | "queued_comment_not_pending"
  | "queued_comment_already_dispatching"
  | "queued_comment_stale_queue"
  | "queued_comment_revision_conflict"
  | "queued_comment_order_mismatch";

/** The route maps this 1:1 onto the `conflict(...)` HTTP error it threw before this move, using `code` and `message` unchanged. */
export class QueuedCommentMutationError extends Error {
  constructor(
    readonly code: QueuedCommentMutationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QueuedCommentMutationError";
  }
}

/** The route maps this onto the `forbidden(...)` HTTP error it threw before this move, using `message` unchanged. */
export class QueuedCommentMutationForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueuedCommentMutationForbiddenError";
  }
}

function requireMutationTarget(queue: QueuedCommentQueueSnapshot, queueId: string, revision: string): void {
  if (queue.queueId !== queueId) {
    throw new QueuedCommentMutationError("queued_comment_stale_queue", "The queued message targets a stale queue");
  }
  if (queue.revision !== revision) {
    throw new QueuedCommentMutationError("queued_comment_revision_conflict", "The queued messages changed in another session");
  }
}

async function updateQueueRunCommentIdsGuarded(
  tx: QueuedCommentQueueTransaction,
  input: { queueRun: QueuedCommentRunRow | null; ids: string[]; updatedAt: Date },
): Promise<QueuedCommentRunRow | null> {
  if (!input.queueRun) return null;
  const updated = await tx.updateQueueRunCommentIds({
    queueRunId: input.queueRun.id,
    contextSnapshot: input.queueRun.contextSnapshot,
    ids: input.ids,
    updatedAt: input.updatedAt,
  });
  if (!updated) {
    throw new QueuedCommentMutationError("queued_comment_already_dispatching", "The queued message is already being dispatched");
  }
  return updated;
}

export type EditQueuedCommentInput = {
  issue: QueuedCommentIssueContext;
  actor: QueuedCommentActor;
  commentId: string;
  queueId: string;
  revision: string;
  body: string;
  now: Date;
};

export type EditQueuedCommentResult = {
  queue: QueuedCommentQueueSnapshot;
  activityPublication: QueuedCommentActivityPublication;
};

export function createEditQueuedComment(deps: {
  issueLock: QueuedCommentIssueLockWriter;
  /** myrmidon(1.7-GRD-MODES): resolves the injection rule mode for the wake's agent. */
  resolveInjectionMode?: (input: { companyId: string; agentId: string }) => Promise<"flag" | "mask" | "block">;
}) {
  return async function editQueuedComment(input: EditQueuedCommentInput): Promise<EditQueuedCommentResult> {
    return deps.issueLock.withLockedQueue(
      { issue: input.issue, actor: input.actor, queueId: input.queueId },
      async (locked, tx) => {
        requireMutationTarget(locked.queue, input.queueId, input.revision);
        const entry = locked.queue.entries.find((candidate) => candidate.comment.id === input.commentId);
        if (!entry) {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        if (!entry.canEdit) {
          throw new QueuedCommentMutationForbiddenError("Only the queued message author can edit it");
        }

        // myrmidon(S5): the edited comment body is stored with secret values masked,
        // like agent comments in issues.ts addComment. Board users editing their own
        // queued message can paste provider output; the mask is applied to the stored
        // text so the secret value never reaches the database.
        const maskedBody = maskSecretsInText(input.body);
        const updated = await tx.updateCommentBody({
          issueId: input.issue.id,
          commentId: input.commentId,
          body: maskedBody,
          updatedAt: input.now,
        });
        if (!updated) {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        await tx.touchIssueUpdatedAt({ issueId: input.issue.id, updatedAt: input.now });
        await tx.syncCommentReferences(input.commentId);
        await tx.syncCommentExternalObjectsSafely(input.commentId);

        const ids = locked.queue.entries.map((candidate) => candidate.comment.id);
        // myrmidon(1.6-GRD): prompt-injection layer on the wake queue payload
        // (part B). When enabled, the external author's text is wrapped in
        // <untrusted-data> markers inside the wake payload the run reads
        // (data, not instructions) and the detector's flag travels next to it.
        // Guard key and body overwrite use existing payload fields — no
        // queue-format migration. The stored comment body and the UI view are
        // always the author's own text.
        // myrmidon(1.7-GRD-MODES): the injection rule's per-agent mode decides
        // what a flagged comment does to the RUN's copy only — flag keeps the
        // wrapped text (1.6.1 behavior), mask replaces the payload body with a
        // neutral placeholder, block replaces it with the refusal notice; the
        // stored comment itself is never altered by any mode.
        let guardrailsPayload = locked.wake.payload; // myrmidon(1.6-GRD)
        if (guardrailsInjectionEnabled()) { // myrmidon(1.6-GRD)
          const { text: wrappedText, scan } = wrapUntrusted( // myrmidon(1.6-GRD)
            maskedBody,
            injectionScoreThreshold(),
          );
          // myrmidon(1.7-GRD-MODES): resolve the mode OUTSIDE the payload
          // build so the injection flag record carries the enforcement the
          // run will see; the default (no resolver, e.g. unit tests) is flag.
          let injectionMode: "flag" | "mask" | "block" = "flag"; // myrmidon(1.7-GRD-MODES)
          if (deps.resolveInjectionMode) { // myrmidon(1.7-GRD-MODES)
            injectionMode = await deps.resolveInjectionMode({ // myrmidon(1.7-GRD-MODES)
              companyId: input.issue.companyId,
              agentId: locked.wake.agentId,
            });
          }
          let payloadBody = wrappedText; // myrmidon(1.7-GRD-MODES)
          if (scan.flagged && injectionMode === "mask") { // myrmidon(1.7-GRD-MODES)
            payloadBody = UNTRUSTED_DATA_OPEN + MASKED_UNTRUSTED_BODY + UNTRUSTED_DATA_CLOSE; // myrmidon(1.7-GRD-MODES)
          } else if (scan.flagged && injectionMode === "block") { // myrmidon(1.7-GRD-MODES)
            payloadBody = UNTRUSTED_DATA_OPEN + BLOCKED_UNTRUSTED_NOTICE + UNTRUSTED_DATA_CLOSE; // myrmidon(1.7-GRD-MODES)
          }
          guardrailsPayload = { // myrmidon(1.6-GRD)
            ...locked.wake.payload,
            commentBody: payloadBody,
            _paperclipGuardrails: {
              ...((locked.wake.payload["_paperclipGuardrails"] as Record<string, unknown>) ?? {}),
              injection: {
                kind: "injection",
                surface: "wake_queue",
                commentId: input.commentId,
                mode: injectionMode, // myrmidon(1.7-GRD-MODES)
                ...scan,
              },
            },
          };
        }
        const updatedWake = await tx.updateWakeQueuedCommentIds({ // myrmidon(1.6-GRD)
          wakeId: locked.wake.id,
          payload: guardrailsPayload,
          ids,
          updatedAt: input.now,
        });
        const updatedQueueRun = await updateQueueRunCommentIdsGuarded(tx, {
          queueRun: locked.queueRun,
          ids,
          updatedAt: input.now,
        });

        const queue = await tx.buildQueueSnapshot({
          issue: input.issue,
          actor: input.actor,
          wake: updatedWake, // myrmidon(1.6-GRD): keep the guardrails-bearing wake row
          state: locked.state,
          queueRun: updatedQueueRun ?? locked.queueRun,
          activeRun: locked.activeRun,
        });

        const activityPublication = await tx.logActivity({
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.agentId,
          runId: input.actor.runId,
          agentApiKeyId: input.actor.agentApiKeyId,
          action: "issue.queued_comment_edited",
          entityId: input.issue.id,
          details: {
            commentId: input.commentId,
            queueId: input.queueId,
            revision: queue.revision,
          },
        });

        return { queue, activityPublication };
      },
    );
  };
}

export type ReorderQueuedCommentsInput = {
  issue: QueuedCommentIssueContext;
  actor: QueuedCommentActor;
  queueId: string;
  revision: string;
  orderedCommentIds: string[];
  now: Date;
};

export type ReorderQueuedCommentsResult = {
  queue: QueuedCommentQueueSnapshot;
  activityPublication: QueuedCommentActivityPublication;
};

export function createReorderQueuedComments(deps: { issueLock: QueuedCommentIssueLockWriter }) {
  return async function reorderQueuedComments(input: ReorderQueuedCommentsInput): Promise<ReorderQueuedCommentsResult> {
    return deps.issueLock.withLockedQueue(
      { issue: input.issue, actor: input.actor, queueId: input.queueId },
      async (locked, tx) => {
        requireMutationTarget(locked.queue, input.queueId, input.revision);

        const currentIds = locked.queue.entries.map((entry) => entry.comment.id);
        const reorderDecision = decideQueuedCommentReorder({ currentIds, orderedIds: input.orderedCommentIds });
        if (reorderDecision.kind === "mismatch") {
          throw new QueuedCommentMutationError(
            "queued_comment_order_mismatch",
            "The queued message order does not match the current queue",
          );
        }

        const updatedWake = await tx.updateWakeQueuedCommentIds({
          wakeId: locked.wake.id,
          payload: locked.wake.payload,
          ids: input.orderedCommentIds,
          updatedAt: input.now,
        });
        const updatedQueueRun = await updateQueueRunCommentIdsGuarded(tx, {
          queueRun: locked.queueRun,
          ids: input.orderedCommentIds,
          updatedAt: input.now,
        });

        const queue = await tx.buildQueueSnapshot({
          issue: input.issue,
          actor: input.actor,
          wake: updatedWake,
          state: locked.state,
          queueRun: updatedQueueRun ?? locked.queueRun,
          activeRun: locked.activeRun,
        });

        const activityPublication = await tx.logActivity({
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.agentId,
          runId: input.actor.runId,
          agentApiKeyId: input.actor.agentApiKeyId,
          action: "issue.queued_comments_reordered",
          entityId: input.issue.id,
          details: {
            queueId: input.queueId,
            revision: queue.revision,
            orderedCommentIds: input.orderedCommentIds,
          },
        });

        return { queue, activityPublication };
      },
    );
  };
}

export type DiscardQueuedCommentInput = {
  issue: QueuedCommentIssueContext;
  actor: QueuedCommentActor;
  commentId: string;
  queueId: string;
  /** Skipped entirely when omitted, matching the comment-delete route's cancellation call site, which does not carry a revision. */
  revision?: string;
  now: Date;
  /**
   * Set only by the queue-discard route. The comment-delete route's
   * cancellation call site omits this: it already logs its own
   * `issue.comment_cancelled` row outside this use case, and this flag
   * would otherwise double-log that same discard.
   */
  logActivity?: boolean;
};

export type DiscardQueuedCommentResult = {
  /** The full deleted comment row; the comment-delete route echoes it back as its own response body. */
  deleted: IssueComment;
  queue: QueuedCommentQueueSnapshot;
  /** Set only when the discard emptied the queue and cancelled a queued run; the caller emits telemetry for it after the transaction commits. */
  cancelledRun: { id: string } | null;
  /** Set only when `input.logActivity` was true; the caller publishes it once the transaction commits. */
  activityPublication: QueuedCommentActivityPublication | null;
};

export function createDiscardQueuedComment(deps: { issueLock: QueuedCommentIssueLockWriter }) {
  return async function discardQueuedComment(input: DiscardQueuedCommentInput): Promise<DiscardQueuedCommentResult> {
    return deps.issueLock.withLockedQueue(
      { issue: input.issue, actor: input.actor, queueId: input.queueId },
      async (locked, tx) => {
        if (input.revision !== undefined) {
          requireMutationTarget(locked.queue, input.queueId, input.revision);
        }

        const entry = locked.queue.entries.find((candidate) => candidate.comment.id === input.commentId);
        if (!entry) {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        const owns = decideQueuedCommentActorOwnsEntry({
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          actorAgentId: input.actor.agentId,
          authorAgentId: entry.comment.authorAgentId,
          authorUserId: entry.comment.authorUserId,
        });
        if (!owns) {
          throw new QueuedCommentMutationForbiddenError("Only the queued message author can discard it");
        }

        const deleted = await tx.deleteComment({ issueId: input.issue.id, commentId: input.commentId });
        if (!deleted) {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        await tx.deleteCommentReferenceSource(input.commentId);
        await tx.syncCommentExternalObjectsSafely(input.commentId);

        const remainingIds = locked.queue.entries.map((candidate) => candidate.comment.id).filter((id) => id !== input.commentId);
        const queueBecomesEmpty = remainingIds.length === 0;

        let cancelledRun: { id: string } | null = null;
        let nextWake = locked.wake;
        let nextQueueRun = locked.queueRun;

        if (queueBecomesEmpty) {
          await tx.cancelWake({
            wakeId: locked.wake.id,
            reason: "Queued message discarded before dispatch",
            now: input.now,
          });
          if (locked.queueRun) {
            const cancelled = await tx.cancelQueueRun({
              queueRunId: locked.queueRun.id,
              reason: "Queued message discarded before dispatch",
              now: input.now,
            });
            if (!cancelled) {
              throw new QueuedCommentMutationError(
                "queued_comment_already_dispatching",
                "The queued message is already being dispatched",
              );
            }
            cancelledRun = cancelled;
            await tx.clearExecutionLockAndTouchIssue({
              issueId: input.issue.id,
              executionRunId: locked.queueRun.id,
              updatedAt: input.now,
            });
          } else {
            await tx.touchIssueUpdatedAt({ issueId: input.issue.id, updatedAt: input.now });
          }
        } else {
          nextWake = await tx.updateWakeQueuedCommentIds({
            wakeId: locked.wake.id,
            payload: locked.wake.payload,
            ids: remainingIds,
            updatedAt: input.now,
          });
          nextQueueRun = await updateQueueRunCommentIdsGuarded(tx, {
            queueRun: locked.queueRun,
            ids: remainingIds,
            updatedAt: input.now,
          });
          await tx.touchIssueUpdatedAt({ issueId: input.issue.id, updatedAt: input.now });
        }

        const queue = await tx.buildQueueSnapshot({
          issue: input.issue,
          actor: input.actor,
          wake: queueBecomesEmpty ? null : nextWake,
          state: queueBecomesEmpty ? null : locked.state,
          queueRun: queueBecomesEmpty ? null : (nextQueueRun ?? locked.queueRun),
          activeRun: locked.activeRun,
        });

        const activityPublication = input.logActivity
          ? await tx.logActivity({
              actorType: input.actor.actorType,
              actorId: input.actor.actorId,
              agentId: input.actor.agentId,
              runId: input.actor.runId,
              agentApiKeyId: input.actor.agentApiKeyId,
              action: "issue.queued_comment_discarded",
              entityId: input.issue.id,
              details: {
                commentId: input.commentId,
                queueId: input.queueId,
                revision: queue.revision,
                cancelledRunId: cancelledRun?.id ?? null,
              },
            })
          : null;

        return { deleted, queue, cancelledRun, activityPublication };
      },
    );
  };
}
