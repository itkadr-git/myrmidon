// Pure decision→event-command mapping for the run-dispatch event sink
// (OPE-12797, ORCH-IO-SPLIT). The adapter owns the transaction and the event
// sink; this file only decides WHAT gets committed: level, message, payload,
// and the activity-log receipt. It imports nothing — the INV-14 decision-layer
// purity rule applies here, so it stays deterministic and testable with plain
// fixtures, no database.

/** Run identity carried on every command so the sink can commit without re-reading. */
export type RunEventIdentity = {
  companyId: string;
  runId: string;
  agentId: string;
};

export type RunLifecycleEventCommand = {
  run: RunEventIdentity;
  level: "info" | "warn" | "error";
  message: string;
  payload: Record<string, unknown>;
  /**
   * Activity-log receipt committed in the SAME transaction as the event.
   * `null` = the path commits the lifecycle event only.
   */
  activityReceipt: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  } | null;
};

/** The staleness decision shape `decideQueuedRunStaleness` returns for a stale run. */
export type StalenessDecisionInput = {
  stale: true;
  errorCode: string;
  reason: string;
  details: Record<string, unknown>;
};

type ScheduledRetryProjection = {
  scheduledRetryAttempt: number | null;
  scheduledRetryAt: Date | string | null;
  scheduledRetryReason: string | null;
};

/** The scheduled-retry facts both retry event payloads carry. */
function scheduledRetryFacts(run: ScheduledRetryProjection): Record<string, unknown> {
  return {
    scheduledRetryAttempt: run.scheduledRetryAttempt,
    scheduledRetryAt: run.scheduledRetryAt
      ? new Date(run.scheduledRetryAt).toISOString()
      : null,
    scheduledRetryReason: run.scheduledRetryReason,
  };
}

/** A due scheduled retry was promoted back into the queued run pool. */
export function scheduledRetryPromotedEventCommand(
  run: RunEventIdentity & ScheduledRetryProjection,
): RunLifecycleEventCommand {
  return {
    run: { companyId: run.companyId, runId: run.runId, agentId: run.agentId },
    level: "info",
    message: "Scheduled retry became due and was promoted to the queued run pool",
    payload: scheduledRetryFacts(run),
    activityReceipt: null,
  };
}

/** A scheduled retry was suppressed by its gate before promotion. */
export function scheduledRetrySuppressedEventCommand(
  run: RunEventIdentity & ScheduledRetryProjection,
  input: { reason: string; details: Record<string, unknown> },
): RunLifecycleEventCommand {
  return {
    run: { companyId: run.companyId, runId: run.runId, agentId: run.agentId },
    level: "warn",
    message: input.reason,
    payload: { ...input.details, ...scheduledRetryFacts(run) },
    activityReceipt: null,
  };
}

/** A queued/running run was cancelled as stale; carries an activity receipt. */
export function staleQueuedRunCancelledEventCommand(
  run: RunEventIdentity,
  decision: StalenessDecisionInput,
): RunLifecycleEventCommand {
  return {
    run: { companyId: run.companyId, runId: run.runId, agentId: run.agentId },
    level: "warn",
    message: decision.reason,
    payload: decision.details,
    activityReceipt: {
      actorId: "queued-run-timeout",
      action: "heartbeat_run.cancelled",
      entityType: "heartbeat_run",
      entityId: run.runId,
      details: {
        reason: decision.reason,
        errorCode: decision.errorCode,
        ...decision.details,
      },
    },
  };
}
