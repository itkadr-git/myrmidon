// The forgotten-pause guard (myrmidon 1.6.5 PAUSE-GUARD) entry point.
//
// Two halves, one module: the scheduler pass that lifts operator pauses left
// behind (sweep.ts) and the settings service the settings page reads and
// writes (service.ts). This file is the only place that binds them to the
// heartbeat service, the instance settings row, the activity log and the
// attention registry, so the rules in sweep.ts stay pure and every vendor file
// keeps a single call site (CONVENTIONS.md section 8).

import type { Db } from "@paperclipai/db";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { logger } from "../../middleware/logger.js";
import { recordPauseGuardSignal } from "./attention.js";
import { pauseGuardRoutes } from "./routes.js";
import { pauseGuardService, type PauseGuardServiceDeps } from "./service.js";
import { createPauseGuardSweep, type PauseGuardSweep } from "./sweep.js";
import type { PauseGuardSettings } from "@paperclipai/shared";

export { createPauseGuardSweep, createPauseGuardStore, decidePauseGuardCandidate } from "./sweep.js";
export type {
  PauseGuardCandidate,
  PauseGuardSweep,
  PauseGuardSweepDeps,
  PauseGuardSweepResult,
} from "./sweep.js";
export { PAUSE_GUARD_ACTIVITY_ACTION, PAUSE_GUARD_WAKE_REASON } from "./sweep.js";
export { pauseGuardService, PAUSE_GUARD_SETTINGS_ACTION } from "./service.js";
export type { PauseGuardActor, PauseGuardService, PauseGuardView } from "./service.js";

/** The narrow heartbeat surface this module uses; the full service satisfies it. */
export interface PauseGuardHeartbeatPort {
  resumeAgentAfterPause: (agentId: string) => Promise<unknown>;
}

/**
 * The sweep the scheduler ticks. Kept in module state so a settings change can
 * arm the next pass through the service's `apply` (the same process-wide shape
 * the run admission limits use for theirs).
 */
let runningSweep: PauseGuardSweep | null = null;

export interface CreatePauseGuardSweepInput {
  db: Db;
  heartbeat: PauseGuardHeartbeatPort;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the pass and remembers it for the settings service. The resume runs
 * through the existing L3 wake chain (`heartbeat.resumeAgentAfterPause` ->
 * myrmidon/pause-drain.ts), so a lifted pause wakes the agent's queued runs and
 * any stranded assigned task exactly as the resume route does.
 */
export function createPauseGuardSweepFromHeartbeat(input: CreatePauseGuardSweepInput): PauseGuardSweep {
  const sweep = createPauseGuardSweep({
    db: input.db,
    resumeWake: (agentId) => input.heartbeat.resumeAgentAfterPause(agentId),
    readStoredSettings: async () => (await instanceSettingsService(input.db).getGeneral()).pauseGuard,
    recordAttention: (companyId, signal) => recordPauseGuardSignal(companyId, signal),
    logActivity: async (entry) => {
      // The pass only needs the append to happen; the log's row id is not part
      // of the sweep's result.
      await logActivity(input.db, entry);
    },
    env: input.env,
  });
  runningSweep = sweep;
  return sweep;
}

function defaultDeps(db: Db): PauseGuardServiceDeps {
  return {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: async (entry) => {
      await logActivity(db, entry);
    },
    apply: (settings: PauseGuardSettings) => {
      // The next scheduler tick runs the pass instead of waiting out the
      // interval the settings just changed.
      runningSweep?.armNow();
      logger.info({ settings }, "pause guard armed for its next pass");
    },
  };
}

/** Router for app.ts: GET/PATCH /api/myrmidon/pause-guard. */
export function myrmidonPauseGuardRoutes(db: Db) {
  return pauseGuardRoutes(db, pauseGuardService(db, defaultDeps(db)));
}

/** Test helper: forget the sweep the settings service arms. */
export function resetPauseGuardSweepForTest(): void {
  runningSweep = null;
}