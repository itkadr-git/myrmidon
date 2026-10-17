// myrmidon(1.6.1 OPE-3983): the event reasonRef the internal service paths
// that enter `blocked` carry, and the sweep-side liveness reader for it.
//
// Part A (OPE-3863) fixed the reasonRef contract: kind="issue" | "event" |
// "date". Part B's sweep (OPE-3864) asks `isEventStillSet(companyId, eventKey)`
// for an event reason; the documented doctrine is that an unwired reason must
// read as still set, so a missing signal never silently unblocks a task.
// Recovery-driven internal blocks (native-failure reconciliation, finalizer
// ambiguity, disposition-repair and stranded-recovery escalation) enter
// `blocked` because an `issue_recovery_actions` incident holds the task, so
// their liveness question is exactly "is that incident still open?" — the
// reader below answers it from the live table.
//
// The event key is issue-scoped because the seam only passes
// (companyId, eventKey). Keep the prefix stable: historical rows may already
// cite it.

import { and, eq, or } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";

/** Event-key prefix for the recovery-incident liveness of one issue. */
export const STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX = "recovery.liveness:";

/** Open recovery-action statuses: the incident still holds the task. */
const OPEN_RECOVERY_ACTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "escalated",
]);

/** The event key naming the recovery-incident liveness of one issue. */
export function recoveryLivenessEventKey(issueId: string): string {
  return `${STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX}${issueId}`;
}

/**
 * The `unblockDescriptor` an internal recovery path writes when it enters
 * `blocked` because a recovery incident holds the task: the board owns the
 * unblock, and the reasonRef lets the stale-block sweep judge the block by
 * the live incident row instead of leaving it as an unknown, never-swept
 * reason.
 */
export function recoveryLivenessDescriptor(
  issueId: string,
  action: string,
): IssueUnblockDescriptor {
  return {
    owner: "board",
    action,
    reasonRef: { kind: "event", eventKey: recoveryLivenessEventKey(issueId) },
  };
}

/** The issue id inside a recovery-liveness key, or null for any other key. */
export function recoveryLivenessIssueId(eventKey: string): string | null {
  if (!eventKey.startsWith(STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX)) return null;
  const issueId = eventKey.slice(STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX.length);
  return /^[0-9a-fA-F-]{36}$/.test(issueId) ? issueId : null;
}

/**
 * Builds the stale-block sweep's event reader. A recovery-liveness key is
 * still set while the issue has a recovery-action row — as the incident
 * source or as the recovery task it created — in an open (`active` /
 * `escalated`) status. An issue with NO incident rows reads as still set:
 * same conservative doctrine as an unwired gate key — the block is only
 * judged dead from an explicitly closed (`resolved` / `cancelled`) incident,
 * never from a missing linkage. Every other key reads as still set.
 */
export function createRecoveryLivenessEventReader(
  db: Db,
): (companyId: string, eventKey: string) => Promise<boolean> {
  return async (companyId, eventKey) => {
    const issueId = recoveryLivenessIssueId(eventKey);
    if (issueId === null) return true;
    const rows = await db
      .select({ status: issueRecoveryActions.status })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          or(
            eq(issueRecoveryActions.sourceIssueId, issueId),
            eq(issueRecoveryActions.recoveryIssueId, issueId),
          ),
        ),
      )
      .limit(100);
    if (rows.length === 0) return true;
    return rows.some((row) => OPEN_RECOVERY_ACTION_STATUSES.has(row.status));
  };
}
