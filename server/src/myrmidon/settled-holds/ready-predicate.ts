// myrmidon(HOLD-READY): one meaning of "ready" for the schedulers that pick an
// agent's next task (idle-pickup, the manual-wake task binding, the swarm role
// queues) and the wake admission that has to accept the wake they send.
//
// The admission (heartbeat.ts) parks every non-explicit wake of an issue that
// still carries an execution hold — an active/escalated reconciliation action,
// or a closed one whose `evidence.automaticRecovery.replay` reads "blocked" —
// as `deferred_issue_execution` with `payload.executionWait`. The schedulers
// used to ignore that hold in their SQL prefilter and then treated the parked
// wake as a wake "already covering" the issue. The result: an issue that no
// scheduler would ever wake again, reported as ready by none of them either
// (the manual wake answered "no ready task"), while the hold could only be
// lifted by hand. See docs/myrmidon/DIVERGENCE.md "HOLD-READY".
import { and, eq, notExists, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { executionBlockerPredicate } from "../../services/execution-blocker.js";

/**
 * SQL condition over the outer `issues` row: the issue has no execution hold
 * an automatic wake would be parked on. It is the same predicate the admission
 * reads (`executionBlockerPredicate`), so an issue this filter keeps is one an
 * idle or queue wake can actually start.
 */
export function issueHasNoExecutionHold(db: Db): SQL {
  return notExists(
    db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, issues.companyId),
          eq(issueRecoveryActions.sourceIssueId, issues.id),
          executionBlockerPredicate(),
        ),
      ),
  );
}

/**
 * SQL condition over an `agent_wakeup_requests` row: the wake is not one the
 * admission parked on an execution hold. Such a wake is not work in flight; it
 * waits for a person to lift the hold, so it must not count as a wake that
 * already covers the issue.
 */
export function wakeNotParkedOnExecutionHold(): SQL {
  // coalesce: a wake with no payload or no `executionWait` key must read
  // "not parked" (true), never SQL NULL, or the caller's filter drops it.
  return sql`not (${agentWakeupRequests.status} = 'deferred_issue_execution' and coalesce(jsonb_typeof(${agentWakeupRequests.payload} -> 'executionWait'), 'null') = 'object')`;
}
