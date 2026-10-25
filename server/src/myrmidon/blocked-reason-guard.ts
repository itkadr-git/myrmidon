// myrmidon(BLOCKED-REASON): the product-level ban on a reasonless `blocked`.
// A transition into blocked is valid only when, after the change, the task has
// at least one reason: an open blocker, `blockerMetadata.blockReason`, or an
// `unblockDescriptor` with an owner and an action. The rule lives in the issue
// service update, the single point every status change passes through, so the
// board, agents and the system paths (recovery, stranded autopolicy, native
// arbiter, monitors) obey exactly the same rule.
import { unprocessable } from "../errors.js";

export const BLOCKED_REQUIRES_REASON_CODE = "blocked_requires_reason";

export const BLOCKED_REQUIRES_REASON_MESSAGE =
  "A task can enter blocked only with a reason: an open blocker (blockedByIssueIds), " +
  "blockerMetadata.blockReason, or unblockDescriptor with an owner and an action. " +
  "Without a reason nobody knows what the task waits for; move it to todo/in_review or state the reason.";

export interface BlockedReasonFacts {
  openBlockerCount: number;
  blockerMetadata: unknown;
  unblockDescriptor: unknown;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasBlockedReason(facts: BlockedReasonFacts): boolean {
  if (facts.openBlockerCount > 0) return true;
  const metadata = facts.blockerMetadata as { blockReason?: unknown } | null | undefined;
  if (metadata && nonEmptyString(metadata.blockReason)) return true;
  const descriptor = facts.unblockDescriptor as { owner?: unknown; action?: unknown } | null | undefined;
  if (descriptor && descriptor.owner != null && descriptor.owner !== "" && nonEmptyString(descriptor.action)) {
    return true;
  }
  return false;
}

/** Throws 422 `blocked_requires_reason` when the facts carry no reason. */
export function assertBlockedHasReason(facts: BlockedReasonFacts): void {
  if (hasBlockedReason(facts)) return;
  throw unprocessable(BLOCKED_REQUIRES_REASON_MESSAGE, { code: BLOCKED_REQUIRES_REASON_CODE });
}

/**
 * Whether a blocked task that just lost its last open blocker may be returned
 * to todo by the system: only when no other reason holds it and an executor
 * exists. A task with a stated reason keeps the reason's owner in charge.
 */
export function isAutoUnblockCandidate(row: {
  status: string;
  conversationAgentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockerMetadata: unknown;
  unblockDescriptor: unknown;
}): boolean {
  if (row.status !== "blocked" || row.conversationAgentId) return false;
  if (!row.assigneeAgentId && !row.assigneeUserId) return false;
  return !hasBlockedReason({ openBlockerCount: 0, blockerMetadata: row.blockerMetadata, unblockDescriptor: row.unblockDescriptor });
}
