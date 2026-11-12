// myrmidon(1.6.1 OPE-3983, 1.6.6 OPE-9963): the event reasonRef the internal
// service paths that enter `blocked` carry, and the sweep-side liveness readers.
//
// Part A (OPE-3863) fixed the reasonRef contract: kind="issue" | "event" |
// "date". Part B's sweep (OPE-3864) asks `isEventStillSet(companyId, eventKey)`
// for an event reason; the documented doctrine is that an unwired reason must
// read as still set, so a missing signal never silently unblocks a task.
//
// 1.6.6 (OPE-9963) introduces an event reader registry covering:
// 1. `recovery.liveness:<issueId>` — recovery action incident status
// 2. `github:` — GitHub broker recovery (latest issued > latest denied)
// 3. `stranded.disposition:<issueId>` — stranded task completed or live agent running

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@myrmidon/db";
import { isAgentStatusInvokable, type IssueUnblockDescriptor } from "@myrmidon/shared";

/** Event-key prefix for the recovery-incident liveness of one issue. */
export const STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX = "recovery.liveness:";

/** Event-key prefix for GitHub broker connection/token recovery. */
export const STALE_BLOCK_GITHUB_EVENT_PREFIX = "github:";

/** Event-key prefix for stranded disposition policy. */
export const STALE_BLOCK_STRANDED_DISPOSITION_EVENT_PREFIX = "stranded.disposition:";

/** Known event-key prefixes with registered readers in stale-block sweep. */
export const REGISTERED_EVENT_KEY_PREFIXES = [
  STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX,
  STALE_BLOCK_GITHUB_EVENT_PREFIX,
  STALE_BLOCK_STRANDED_DISPOSITION_EVENT_PREFIX,
] as const;

/** Check whether an event key matches any registered prefix. */
export function isRegisteredEventKey(eventKey: string): boolean {
  return REGISTERED_EVENT_KEY_PREFIXES.some((prefix) => eventKey.startsWith(prefix));
}

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

/** The issue id inside a stranded-disposition key, or null for any other key. */
export function strandedDispositionIssueId(eventKey: string): string | null {
  if (!eventKey.startsWith(STALE_BLOCK_STRANDED_DISPOSITION_EVENT_PREFIX)) return null;
  const issueId = eventKey.slice(STALE_BLOCK_STRANDED_DISPOSITION_EVENT_PREFIX.length);
  return /^[0-9a-fA-F-]{36}$/.test(issueId) ? issueId : null;
}

/**
 * Builds the recovery-liveness event reader. A recovery-liveness key is
 * still set while the issue has a recovery-action row — as the incident
 * source or as the recovery task it created — in an open (`active` /
 * `escalated`) status. An issue with NO incident rows reads as still set:
 * same conservative doctrine as an unwired gate key — the block is only
 * judged dead from an explicitly closed (`resolved` / `cancelled`) incident,
 * never from a missing linkage. Every other key reads as still set.
 */
export function createRecoveryLivenessEventReader(
  db: Db,
): (companyId: string, eventKey: string, dbOrTx?: Db) => Promise<boolean> {
  return async (companyId, eventKey, dbOrTx) => {
    const issueId = recoveryLivenessIssueId(eventKey);
    if (issueId === null) return true;
    // Inside the unblock transaction the caller passes `tx`: one connection,
    // and the read sees the transaction's own state (OPE-9078).
    const rows = await (dbOrTx ?? db)
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

/**
 * Builds the GitHub broker event reader.
 * Event key prefix: `github:`.
 * Recovery event condition: the latest `myrmidon.github_app.issued` event in
 * activityLog is strictly newer than the latest `myrmidon.github_app.denied` event.
 * If this condition is met, the broker is healthy and the block event is cleared (returns false).
 */
export function createGithubEventReader(
  db: Db,
): (companyId: string, eventKey: string, dbOrTx?: Db) => Promise<boolean> {
  return async (companyId, eventKey, dbOrTx) => {
    if (!eventKey.startsWith(STALE_BLOCK_GITHUB_EVENT_PREFIX)) return true;
    const [latestIssued, latestDenied] = await Promise.all([
      (dbOrTx ?? db)
        .select({ createdAt: activityLog.createdAt })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "myrmidon.github_app.issued"),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(1)
        .then((rows) => rows[0]?.createdAt ?? null),
      (dbOrTx ?? db)
        .select({ createdAt: activityLog.createdAt })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "myrmidon.github_app.denied"),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(1)
        .then((rows) => rows[0]?.createdAt ?? null),
    ]);

    // Latest issued after latest denied -> event cleared (isEventStillSet = false)
    if (latestIssued && (!latestDenied || latestIssued.getTime() > latestDenied.getTime())) {
      return false;
    }
    return true;
  };
}

/**
 * Builds the stranded disposition event reader.
 * Event key prefix: `stranded.disposition:<issueId>`.
 * Cleared condition:
 * - the issue reached a non-blocked terminal status, OR
 * - the issue has a live invokable assignee agent with an active (queued/running) heartbeat run.
 */
export function createStrandedDispositionEventReader(
  db: Db,
): (companyId: string, eventKey: string, dbOrTx?: Db) => Promise<boolean> {
  return async (companyId, eventKey, dbOrTx) => {
    const issueId = strandedDispositionIssueId(eventKey);
    if (issueId === null) return true;

    const [issue] = await (dbOrTx ?? db)
      .select({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .limit(1);

    if (!issue) return false;
    if (issue.status !== "blocked") return false;

    if (issue.assigneeAgentId) {
      const [agent] = await (dbOrTx ?? db)
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, companyId)))
        .limit(1);

      if (agent && isAgentStatusInvokable(agent.status)) {
        const [activeRun] = await (dbOrTx ?? db)
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.agentId, issue.assigneeAgentId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            ),
          )
          .limit(1);
        if (activeRun) return false;
      }
    }

    return true;
  };
}

/**
 * Composite registry of all event readers used by the stale-block sweep.
 */
export function createDefaultEventReader(
  db: Db,
): (companyId: string, eventKey: string, dbOrTx?: Db) => Promise<boolean> {
  const recoveryReader = createRecoveryLivenessEventReader(db);
  const githubReader = createGithubEventReader(db);
  const strandedReader = createStrandedDispositionEventReader(db);

  return async (companyId, eventKey, dbOrTx) => {
    if (eventKey.startsWith(STALE_BLOCK_RECOVERY_LIVENESS_EVENT_PREFIX)) {
      return recoveryReader(companyId, eventKey, dbOrTx);
    }
    if (eventKey.startsWith(STALE_BLOCK_GITHUB_EVENT_PREFIX)) {
      return githubReader(companyId, eventKey, dbOrTx);
    }
    if (eventKey.startsWith(STALE_BLOCK_STRANDED_DISPOSITION_EVENT_PREFIX)) {
      return strandedReader(companyId, eventKey, dbOrTx);
    }
    return true;
  };
}
