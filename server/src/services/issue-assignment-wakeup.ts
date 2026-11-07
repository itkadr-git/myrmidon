import { logger } from "../middleware/logger.js";
import { isConversation } from "./agent-conversations.js";
import type { DurableChatWakeupRequest } from "./durable-chat-wakeup.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
      allowRunCoalescing?: boolean;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
      durableChatRequest?: DurableChatWakeupRequest;
    },
  ) => Promise<unknown>;
}

// myrmidon(1.6.6 PLUGIN-REGISTRY 2/3): mirrors vendor paperclipai/paperclip
// #13738 (commit 0f5fafe16). A closed issue must never queue an assignment
// wake. The guard lives in this single shared service, not per call point, so
// every caller (issue create, child_create, accepted_plan_decomposition,
// interaction_accept, status-card/summary-slot generation, chat/routine/
// secret-proposal wakes) is covered at once. An explicit status transition
// that reopens a closed issue still wakes the assignee through the normal
// PATCH/update path — that path reads the NEW status before queueing.
function isClosedIssueStatus(
  status: string | null | undefined,
): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

/** Why a wake was not queued: the agent that made the change is the assignee. */
export const SELF_WAKE_SKIPPED_REASON = "self_wake_skipped";

// myrmidon(1.6.6 OPE-12049, TOKEN-BURN H): an agent never wakes itself with its
// own write. The agent that PATCHes, creates or comments on a task is, by
// definition, inside a run: it already holds the context the wake would build,
// so the wake only pays one more empty session (07.11: the adm bot burned ten
// empty runs an hour on "Wake from own PATCH (issue_assigned)"). The actor the
// caller reports is compared with the assignee here, in the one shared
// service, so every call point is covered at once. A user, a system actor or
// another agent still wakes the assignee as before.
export function isSelfWake(input: {
  assigneeAgentId: string | null | undefined;
  requestedByActorType?: "user" | "agent" | "system" | null;
  requestedByActorId?: string | null;
}): boolean {
  return (
    input.requestedByActorType === "agent" &&
    Boolean(input.requestedByActorId) &&
    input.requestedByActorId === input.assigneeAgentId
  );
}

/**
 * Queues the assignee's wake. Returns `undefined` when the issue cannot be woken
 * (no assignee, backlog, closed), `null` when the wake was skipped because the
 * assignee made the change itself (`SELF_WAKE_SKIPPED_REASON`, logged) or could
 * not be queued, and the wake's promise otherwise.
 */
export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: {
    id: string;
    assigneeAgentId: string | null;
    status: string;
    conversationAgentId?: string | null;
    conversationUserId?: string | null;
  };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  taskKey?: string | null;
  /** Latest issue comment that caused this wakeup. Included in both payload
   * and context so the heartbeat can build the exact turn that was requested. */
  wakeCommentId?: string | null;
  /**
   * Stored on the wake request so a wake can be traced to the pass that made it.
   * It does NOT drop a duplicate: the wake layer dedupes on a key only for its
   * own recovery wakes. "One task, one run" is held by the swarm lease and the
   * matcher's assignee check (see `swarmMatchedIdempotencyKey`).
   */
  idempotencyKey?: string | null;
  /** Closed, server-derived omission counts for provider attachments on the
   * exact wake comment. These are prompt diagnostics, never authorization. */
  attachmentOmissionReasons?: Record<string, number> | null;
  rethrowOnError?: boolean;
  durableChatRequest?: DurableChatWakeupRequest;
}) {
  if (
    !input.issue.assigneeAgentId ||
    input.issue.status === "backlog" ||
    isClosedIssueStatus(input.issue.status)
  ) {
    return;
  }

  if (
    isSelfWake({
      assigneeAgentId: input.issue.assigneeAgentId,
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId,
    })
  ) {
    logger.info(
      {
        issueId: input.issue.id,
        agentId: input.issue.assigneeAgentId,
        reason: input.reason,
        mutation: input.mutation,
        skipped: SELF_WAKE_SKIPPED_REASON,
      },
      "issue assignment wake skipped: the actor is the assignee",
    );
    return null;
  }

  // myrmidon(X8a): an Agent Chat conversation keeps one provider session
  // keyed by issue id, regardless of the taskKey a caller passed in. Without
  // this, a connector-driven conversation (taskKey = issue.identifier) and
  // the web conversation UI (taskKey = issue.id, see agent-conversations.ts)
  // race for the same issue on two different provider sessions, and /new
  // -- which deletes the session by issue.id -- only ever clears one of them.
  const taskKey = isConversation(input.issue) ? input.issue.id : input.taskKey;

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        issueId: input.issue.id,
        mutation: input.mutation,
        ...(taskKey ? { taskKey } : {}),
        ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
      },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      ...(input.durableChatRequest
        ? { durableChatRequest: input.durableChatRequest }
        : {}),
      contextSnapshot: {
        issueId: input.issue.id,
        source: input.contextSource,
        ...(taskKey ? { taskKey } : {}),
        ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
        ...(input.wakeCommentId && input.attachmentOmissionReasons
          ? {
              externalAttachmentOmissions: [
                {
                  commentId: input.wakeCommentId,
                  reasons: input.attachmentOmissionReasons,
                },
              ],
            }
          : {}),
      },
    })
    .catch((err) => {
      logger.warn(
        { err, issueId: input.issue.id },
        "failed to wake assignee on issue assignment",
      );
      if (input.rethrowOnError) throw err;
      return null;
    });
}
