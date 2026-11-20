import type { IssueUnblockDescriptor } from "@myrmidon/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

type RoutableBlockedIssue = {
  id: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
  assigneeAgentId?: string | null;
};

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

// myrmidon(UNBLOCK-REQUEST-NO-SELF-WAKE): minimum gap between two
// `issue_unblock_requested` wakes for one issue and one owner when the block
// metadata carries no usable `nextCheckAt`. Without it an agent that re-blocks
// the issue after every wake is woken again by every new blocked transition
// (17 empty runs in 15 minutes on 16.11).
export const UNBLOCK_REQUEST_MIN_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Decide whether a repeat unblock request may be delivered. A new external
 * event (comment by another author, blocker change) after the previous wake
 * always lifts the limit. Otherwise the next wake waits until `nextCheckAt`
 * (when it lies after the previous wake) or for the default interval.
 */
export function isUnblockRequestDue(input: {
  now: Date;
  lastWakeAt?: Date | null;
  lastExternalEventAt?: Date | null;
  nextCheckAt?: string | Date | null;
}): boolean {
  const { lastWakeAt } = input;
  if (!lastWakeAt) return true;
  if (input.lastExternalEventAt && input.lastExternalEventAt.getTime() > lastWakeAt.getTime()) return true;
  const next = input.nextCheckAt == null ? null : new Date(input.nextCheckAt);
  const dueAt =
    next && !Number.isNaN(next.getTime()) && next.getTime() > lastWakeAt.getTime()
      ? next.getTime()
      : lastWakeAt.getTime() + UNBLOCK_REQUEST_MIN_INTERVAL_MS;
  return input.now.getTime() >= dueAt;
}

export type UnblockNotificationOutcome =
  | "woken"
  | "ineligible"
  | "self_owner_escalated"
  | "self_owner_logged"
  | "throttled";

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string };
    contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  now?: () => Date;
  nextCheckAt?: string | Date | null;
  /** Previous `issue_unblock_requested` wake of this issue to the given agent. */
  lastWakeAt?: (agentId: string) => Promise<Date | null>;
  /** Latest external event on the issue (comment by another author, blocker change). */
  lastExternalEventAt?: (ownerAgentId: string) => Promise<Date | null>;
  /** Lead or project owner to escalate to when the owner is the assignee itself. */
  resolveEscalationAgentId?: () => Promise<string | null>;
  onOutcome?: (outcome: UnblockNotificationOutcome, detail: { ownerAgentId: string; targetAgentId: string | null }) => Promise<unknown> | unknown;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  const now = input.now ?? (() => new Date());
  const ownerAgentId = owner.agentId;
  let targetAgentId = ownerAgentId;
  let selfOwner = false;
  // The assignee already knows what it waits for: do not wake it to unblock itself.
  if (issue.assigneeAgentId && issue.assigneeAgentId === ownerAgentId) {
    selfOwner = true;
    const escalation = input.resolveEscalationAgentId ? await input.resolveEscalationAgentId() : null;
    if (!escalation || escalation === ownerAgentId) {
      await input.onOutcome?.("self_owner_logged", { ownerAgentId, targetAgentId: null });
      return false;
    }
    targetAgentId = escalation;
  }

  if (input.lastWakeAt) {
    const due = isUnblockRequestDue({
      now: now(),
      lastWakeAt: await input.lastWakeAt(targetAgentId),
      lastExternalEventAt: input.lastExternalEventAt ? await input.lastExternalEventAt(ownerAgentId) : null,
      nextCheckAt: input.nextCheckAt,
    });
    if (!due) {
      await input.onOutcome?.("throttled", { ownerAgentId, targetAgentId });
      return false;
    }
  }

  await input.wakeup(targetAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  await input.markNotified(now());
  await input.onOutcome?.(selfOwner ? "self_owner_escalated" : "woken", { ownerAgentId, targetAgentId });
  return true;
}

// myrmidon(STALE-BLOCK): transitions into blocked after this rollout moment
// must carry a reason reference (blockedByIssueIds or unblockDescriptor.reasonRef);
// records blocked earlier stay valid and are never retro-rejected.
export const STALE_BLOCK_ROLLOUT_AT = new Date("2026-10-04T13:40:54.000Z");

export function isStaleBlockGuardedTransition(input: {
  status: string;
  blockedTransitionAt?: Date | string | null;
}): boolean {
  const transitionAt =
    input.blockedTransitionAt == null
      ? null
      : input.blockedTransitionAt instanceof Date
        ? input.blockedTransitionAt
        : new Date(input.blockedTransitionAt);
  return (
    input.status === "blocked" &&
    transitionAt !== null &&
    !Number.isNaN(transitionAt.getTime()) &&
    transitionAt.getTime() >= STALE_BLOCK_ROLLOUT_AT.getTime()
  );
}
