import { agentWakeupRequests, heartbeatRuns, type Db } from "@myrmidon/db";
import type { heartbeatService } from "../../services/heartbeat.js";

// Structural view of the one heartbeat-service method the drain needs. Named
// instead of ReturnType<typeof heartbeatService> so the contract stays visible
// and decoupled from the service factory.
interface HeartbeatDrain {
  drainActiveRunExecutions(): Promise<void>;
}

// A run that can still start or is still executing. scheduled_retry is a run
// parked for a later retry; it still owns a wake row and must not be orphaned
// by teardown.
const PENDING_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
// A wake whose request has not reached a terminal state. This set matches
// IN_FLIGHT_DEPENDENCY_WAKE_STATUSES in services/issue-dependency-wakeups.ts.
const PENDING_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "running",
  "retrying",
  "scheduled_retry",
] as const;

// Await every background heartbeat run until the run and wake tables are
// quiescent. A route dispatches a wakeup fire-and-forget (void
// heartbeat.wakeup(...) in routes/issues.ts). Such a wakeup, or a run it
// dispatches, can write issues, issue_comments, and heartbeat_runs rows during
// teardown and race the deletes in a suite afterEach or afterAll (a
// heartbeat_runs delete deadlocks on the ON DELETE SET NULL cascade to issues;
// an issue_comments insert breaks the later delete of issues).
// drainActiveRunExecutions() awaits both in-flight wakeup promises and
// in-flight run executions, so it also waits for a wakeup that is still before
// run registration. Re-check the run and wake tables after the drain as a
// backstop, and give a late run a macrotask before the next attempt, until no
// run or wake is in flight.
//
// OPE-12856: a run can reach a terminal status while a fire-and-forget
// epilogue (a bounded-retry wake insert, a durable receipt write) is still in
// flight; that epilogue leaves no pending row to observe and no promise in the
// tracked sets, so returning on the first quiet check races its INSERT against
// the cleanup deletes (FK violations on agent_wakeup_requests and
// company_skills in CI). Require several consecutive quiet checks spaced by a
// macrotask so such an epilogue lands before callers start deleting rows. The
// pending-row give-up budget stays at 50 attempts like before, so a suite
// that intentionally keeps a stuck row waits no longer than it already did.
const QUIET_CHECKS_NEEDED = 3;
const QUIET_CHECK_DELAY_MS = 25;
const MAX_ATTEMPTS = 50;
const PENDING_DELAY_MS = 10;

export async function drainHeartbeatRunsToQuiescence(db: Db, heartbeat: HeartbeatDrain) {
  let quietChecks = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    const wakes = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests);
    const hasPending =
      runs.some((run) =>
        (PENDING_RUN_STATUSES as readonly string[]).includes(run.status),
      ) ||
      wakes.some((wake) =>
        (PENDING_WAKE_STATUSES as readonly string[]).includes(wake.status),
      );
    if (hasPending) {
      quietChecks = 0;
      const pendingWait = Promise.withResolvers<void>();
      setTimeout(pendingWait.resolve, PENDING_DELAY_MS);
      await pendingWait.promise;
      continue;
    }
    quietChecks += 1;
    if (quietChecks >= QUIET_CHECKS_NEEDED) return;
    const quietWait = Promise.withResolvers<void>();
    setTimeout(quietWait.resolve, QUIET_CHECK_DELAY_MS);
    await quietWait.promise;
  }
}
