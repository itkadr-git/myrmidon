// myrmidon(OPE-12297): the unblock-owner wake must not burn a daily run slot.
//
// `deliverAgentUnblockNotification` (services/routable-blocked.ts) and the
// stranded autopolicy (services/recovery/service.ts) wake the owner named by
// the issue's `unblockDescriptor` with the reason `issue_unblock_requested`.
// That owner is usually NOT the issue assignee (the assignee keeps the card),
// so the queued-run staleness gate cancels the run as `issue_assignee_changed`
// and the slot the wake spent from `maxDailyRuns` is gone. Worse, a task that
// keeps getting recovered re-enqueues the wake once per recovery attempt.
//
// Part A (run-dispatch): the wake of the descriptor owner on a blocked issue
// is a legitimate operator run — the gate must not cancel it for ownership.
// `isUnblockOwnerWakeRecipient` binds the bypass to the issue still being
// `blocked` and to the run's agent still being the descriptor owner: a
// stranger, or a task that moved on, gets no bypass and is cancelled as before.
//
// Part B (delivery dedup): one blocked episode gets one unblock wake. The
// wake is skipped when a non-skipped `issue_unblock_requested` wake for the
// same issue was already requested after the episode's `blockedTransitionAt`.
// A task that left blocked and re-entered it (new `blockedTransitionAt`) is a
// new episode and wakes the owner again — one wake per new event.

import { and, eq, gt, gte, ne, sql } from "drizzle-orm";
import { agentWakeupRequests, issues, type Db } from "@myrmidon/db";

export { UNBLOCK_OWNER_WAKE_COOLDOWN_MS } from "../services/routable-blocked.js";

export const UNBLOCK_OWNER_WAKE_REASON = "issue_unblock_requested";

/** True when the run's agent is the owner named by the issue's unblock descriptor. */
export async function isUnblockOwnerWakeRecipient(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<boolean> {
  const [issue] = await db
    .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  if (!issue || issue.status !== "blocked") return false;
  const owner = issue.unblockDescriptor?.owner;
  return typeof owner === "object" && owner !== null && "agentId" in owner && owner.agentId === input.agentId;
}

/**
 * True when an unblock wake for this issue was already requested in the current
 * block episode (requested at or after `blockedTransitionAt`; `skipped` wakes
 * never ran and do not count).
 */
export async function hasUnblockOwnerWakeInBlockEpisode(
  db: Db,
  input: { companyId: string; issueId: string; blockedTransitionAt: Date },
): Promise<boolean> {
  const [wake] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, UNBLOCK_OWNER_WAKE_REASON),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        ne(agentWakeupRequests.status, "skipped"),
        gt(agentWakeupRequests.requestedAt, input.blockedTransitionAt),
      ),
    )
    .limit(1);
  return wake !== undefined;
}

/**
 * myrmidon(OPE-12297): recent-delivery guard for the descriptor fingerprint.
 * True when a non-skipped `issue_unblock_requested` wake carrying the same
 * `descriptorFingerprint` in its payload was requested at or after `since`.
 * Used by both delivery sites (routable-blocked and the stranded autopolicy)
 * so a blocked↔in_progress flap cannot deliver a fresh wake every cycle.
 */
export async function hasRecentUnblockOwnerWakeWithFingerprint(
  db: Db,
  input: { companyId: string; issueId: string; descriptorFingerprint: string; since: Date },
): Promise<boolean> {
  const [wake] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, UNBLOCK_OWNER_WAKE_REASON),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        sql`${agentWakeupRequests.payload} ->> 'descriptorFingerprint' = ${input.descriptorFingerprint}`,
        ne(agentWakeupRequests.status, "skipped"),
        gte(agentWakeupRequests.requestedAt, input.since),
      ),
    )
    .limit(1);
  return wake !== undefined;
}
