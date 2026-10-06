// Run stall detection wiring: turns the pure sweep into the pass the scheduler
// calls, binding it to the heartbeat service, the issue service, the activity
// log and the maintenance gate. Every side effect the sweep performs enters
// here, so the rules above stay testable and each vendor file keeps a single
// call site (CONVENTIONS.md §8).

import type { Db } from "@paperclipai/db";
import type { RunStallValues } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { instanceSettingsService } from "../../services/index.js";
import { isRunUnderMaintenance } from "../maintenance/gate.js";
import {
  RUN_STALL_ERROR_CODE,
  RUN_STALL_INTERRUPT_REASON,
  RUN_STALL_WAKE_IDEMPOTENCY_PREFIX,
  RUN_STALL_WAKE_REASON,
} from "./constants.js";
import { runStallRoutes } from "./routes.js";
import { runStallService, type RunStallServiceDeps } from "./settings-service.js";
import { createRunStallSweep, type RunStallSweep } from "./sweep.js";
// myrmidon(TEAM-LIVENESS-SETTINGS): the effective knobs the pass obeys, resolved
// from the settings row over the environment on every pass.
import { teamLivenessReader, type TeamLivenessReader } from "../team-liveness/settings.js";

/** The narrow heartbeat surface this module uses; the full service satisfies it. */
export interface RunStallHeartbeatPort {
  cancelRun: (
    runId: string,
    reason?: string,
    options?: {
      errorCode?: string;
      resultJson?: Record<string, unknown>;
      eventMessage?: string;
      suppressImmediateRecovery?: boolean;
    },
  ) => Promise<unknown>;
  wakeup: (
    agentId: string,
    options: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string;
      payload?: Record<string, unknown>;
      contextSnapshot?: Record<string, unknown>;
      idempotencyKey?: string | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string;
    },
  ) => Promise<unknown>;
}

/** The narrow issue-service surface this module uses. */
export interface RunStallIssuePort {
  updateForCompany: (
    id: string,
    companyId: string,
    data: { status?: string; executionState?: null },
  ) => Promise<unknown>;
}

export interface CreateRunStallSweepInput {
  db: Db;
  heartbeat: RunStallHeartbeatPort;
  issues: RunStallIssuePort;
  isRunUnderMaintenance?: (runId: string) => Promise<boolean>;
  /**
   * myrmidon(TEAM-LIVENESS-SETTINGS): the effective knobs. Absent means the pass
   * reads the settings row itself (the default below).
   */
  readLiveness?: TeamLivenessReader;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the run-stall pass.
 *
 * The interrupt reuses the maintenance chain: a bounded cancel with its own
 * error code, and `suppressImmediateRecovery` because this sweep itself
 * re-opens the task and wakes the assignee. The code is exempted from the
 * vendor's reconciliation hold the same way the maintenance code is, so the run
 * is treated as resumable and never settled as a replay-blocked failure.
 */
export function createRunStallSweepFromHeartbeat(input: CreateRunStallSweepInput): RunStallSweep {
  return createRunStallSweep({
    db: input.db,
    interruptRun: async ({ runId, issueId, silenceMs }) => {
      await input.heartbeat.cancelRun(runId, RUN_STALL_INTERRUPT_REASON, {
        errorCode: RUN_STALL_ERROR_CODE,
        resultJson: {
          myrmidonRunStall: {
            silenceMs,
            issueId,
          },
        },
        eventMessage: "run interrupted: no recorded progress within the stall threshold",
        // The task is re-opened by this sweep and the assignee is woken right
        // after, so the release path must not fire its own escalation on top.
        suppressImmediateRecovery: true,
      });
    },
    returnIssueToTodo: async ({ issueId, companyId }) => {
      await input.issues.updateForCompany(issueId, companyId, { status: "todo", executionState: null });
      return true;
    },
    wakeAssignee: async ({ agentId, issueId, runId, identifier }) => {
      const wake = await input.heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: RUN_STALL_WAKE_REASON,
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey: issueId,
          source: RUN_STALL_WAKE_IDEMPOTENCY_PREFIX,
          stalledRunId: runId,
        },
        idempotencyKey: `${RUN_STALL_WAKE_IDEMPOTENCY_PREFIX}:${runId}`,
        requestedByActorType: "system",
        requestedByActorId: RUN_STALL_WAKE_IDEMPOTENCY_PREFIX,
      });
      if (!wake) {
        // The admission path refused (pause, limits, coalescing): that is a
        // decision, not an error. The task stays `todo` and the normal wake path
        // picks it up, so this pass reports "not woken" and moves on.
        logger.info({ agentId, issueId, identifier, runId }, "run stall wake was not admitted");
        return false;
      }
      return true;
    },
    isRunUnderMaintenance: input.isRunUnderMaintenance ?? ((runId) => isRunUnderMaintenance(input.db, runId)),
    // Stored instance settings beat the environment; the sweep reads them once
    // per pass, so a saved threshold or switch takes effect without a restart.
    readLiveness: input.readLiveness ?? teamLivenessReader(input.db, input.env),
    logActivity: async (entry) => {
      await logActivity(input.db, {
        companyId: entry.companyId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        agentId: entry.agentId,
        runId: entry.runId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        details: entry.details,
      });
    },
    env: input.env,
  });
}

export { createRunStallSweep, type RunStallSweep, type RunStallSweepResult } from "./sweep.js";
export { countRunStallInterrupts, RUN_STALL_METRIC_WINDOW_MS } from "./metrics.js";
export { RUN_STALL_ERROR_CODE, RUN_STALL_WAKE_REASON } from "./constants.js";
export { classifyRunStall, progressAnchorAt, progressSilenceMs, shouldReturnIssueToTodo } from "./policy.js";
export { readRunStallSettings, readRunStallEnabled } from "./settings.js";
export { runStallService, RUN_STALL_ACTION } from "./settings-service.js";
export type {
  RunStallActor,
  RunStallService,
  RunStallServiceDeps,
  RunStallView,
} from "./settings-service.js";
export { runStallRoutes } from "./routes.js";

// myrmidon(RUN-STALL-SETTINGS, 1.6.5, OPE-5087): the live sweep instance a
// settings write applies to. The sweep is built later in startup than the
// routes are mounted (it needs the heartbeat service), so the apply target is
// a registry entry, not a constructor argument: a PATCH that lands before the
// sweep exists still persists and audits, and startup applies the stored row
// to the sweep when it is created — the write is never lost.
let liveRunStallSweep: RunStallSweep | null = null;

export function registerRunStallSweep(sweep: RunStallSweep | null): void {
  liveRunStallSweep = sweep;
}

export function applyRunStallSettings(settings: RunStallValues): void {
  liveRunStallSweep?.applySettings(settings);
}

function defaultRunStallDeps(db: Db): RunStallServiceDeps {
  return {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: applyRunStallSettings,
  };
}

/** Router for app.ts: GET/PATCH /api/myrmidon/run-stall. */
export function myrmidonRunStallRoutes(db: Db) {
  return runStallRoutes(db, runStallService(db, defaultRunStallDeps(db)));
}

/**
 * Startup: put the stored run stall detection settings in force. A failed read
 * must not stop the server: the sweep keeps the environment values it was
 * created with, which is exactly the pre-feature behaviour.
 */
export async function startRunStall(db: Db): Promise<void> {
  try {
    const view = await runStallService(db, defaultRunStallDeps(db)).read();
    applyRunStallSettings({
      enabled: view.settings.enabled,
      thresholdSec: view.settings.thresholdSec,
      checkIntervalSec: view.settings.checkIntervalSec,
      pageSize: view.settings.pageSize,
    });
    logger.info(
      { settings: view.settings, sources: view.sources },
      "run stall detection settings at startup",
    );
  } catch (err) {
    logger.error(
      { err },
      "failed to read the stored run stall detection settings; the environment values stay in force",
    );
  }
}
