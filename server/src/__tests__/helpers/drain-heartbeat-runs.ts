import { heartbeatRuns, type Db } from "@myrmidon/db";

// The structural shape of the one heartbeat-service method the drain needs;
// named at this module so the contract stays visible and decoupled from the
// service factory's own interface.
interface HeartbeatDrain {
  drainActiveRunExecutions(): Promise<void>;
}

// A run that can still start or is still executing. scheduled_retry is a run
// parked for a later retry; it still owns a wake row and must not be orphaned
// by teardown.
const PENDING_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

// Await every background heartbeat run until the run table is quiescent. A
// route dispatches a wakeup fire-and-forget (void heartbeat.wakeup(...) in
// routes/issues.ts), and drainActiveRunExecutions() awaits both the in-flight
// wakeup promises and the run executions they registered, so a teardown-owned
// wake is awaited through its promise, not through its row. Do not poll
// agent_wakeup_requests rows here: a caller may intentionally assert on a
// queued wake that the operation under test just created (OPE-12856 CI: the
// sweep tests' own issue_monitor_timeout wakes kept this drain looping), and
// a queued row awaiting an assertion is not teardown-owned work.
// Re-check the run table after the drain as a backstop, and give a late run a
// macrotask before the next attempt, until no run is in flight.
//
// OPE-12856: a run can reach a terminal status while a fire-and-forget
// epilogue (a durable receipt write) is still in flight; that epilogue leaves
// no pending row to observe and no promise in the tracked sets, so returning
// on the first quiet check races its write against the cleanup deletes.
// Require several consecutive quiet checks spaced by a macrotask. The
// pending-run give-up budget stays at 50 attempts like before.
const QUIET_CHECKS_NEEDED = 3;
const QUIET_CHECK_DELAY_MS = 25;
const MAX_ATTEMPTS = 50;
const PENDING_DELAY_MS = 10;

export async function drainHeartbeatRunsToQuiescence(db: Db, heartbeat: HeartbeatDrain) {
  let quietChecks = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    const hasPending = runs.some((run) =>
      (PENDING_RUN_STATUSES as readonly string[]).includes(run.status),
    );
    if (hasPending) {
      quietChecks = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, PENDING_DELAY_MS));
      continue;
    }
    quietChecks += 1;
    if (quietChecks >= QUIET_CHECKS_NEEDED) return;
    await new Promise<void>((resolve) => setTimeout(resolve, QUIET_CHECK_DELAY_MS));
  }
}
