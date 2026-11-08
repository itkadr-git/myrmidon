import { createHash } from "node:crypto";
import type { IssueUnblockDescriptor } from "@myrmidon/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

type RoutableBlockedIssue = {
  id: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

// myrmidon(OPE-12297): a blocked↔in_progress flap (for example the wake run of
// the descriptor owner being cancelled and the task bouncing back) used to
// clear `blockedOwnerNotifiedAt` on every re-entry into blocked and deliver a
// fresh wake each cycle — 18 wakes per hour for a single task. The descriptor
// fingerprint is the dedup key: a wake is skipped while an identical-descriptor
// wake was requested inside the cooldown window, so repeats only follow a real
// new event (a changed descriptor, a changed blocker set, or a re-entry after
// the cooldown has elapsed).
export const UNBLOCK_OWNER_WAKE_COOLDOWN_MS = 60 * 60 * 1000;

export function unblockDescriptorFingerprint(descriptor: IssueUnblockDescriptor): string {
  const canonical = JSON.stringify({
    owner: descriptor.owner,
    action: descriptor.action,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string; descriptorFingerprint: string };
    contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  /**
   * Optional recent-delivery guard: resolves true when an identical-descriptor
   * wake was already requested inside the cooldown window. The caller passes a
   * db-backed check; omitting it keeps the historical behavior.
   */
  wasRecentlyNotified?: (fingerprint: string, since: Date) => Promise<boolean>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  const fingerprint = unblockDescriptorFingerprint(issue.unblockDescriptor);
  const now = (input.now ?? (() => new Date()))();
  if (input.wasRecentlyNotified) {
    const recent = await input.wasRecentlyNotified(
      fingerprint,
      new Date(now.getTime() - UNBLOCK_OWNER_WAKE_COOLDOWN_MS),
    );
    if (recent) return false;
  }

  await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action, descriptorFingerprint: fingerprint },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  await input.markNotified(now);
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
