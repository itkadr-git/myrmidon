// Live run admission limits (myrmidon C0, RUNTIME-LIMITS) entry point.
//
// Startup: read the stored limits once and put them in force before the
// scheduler starts runs, so an instance whose ceiling was lowered from the
// settings page does not restart with the environment value again. After that
// every settings write applies itself (see service.ts).

import { asc, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { heartbeatService, instanceSettingsService, logActivity } from "../../services/index.js";
import {
  applyRunAdmissionLimits,
  currentHostCpuGate,
  scheduleQueuedResweep,
  sharedRunAdmission,
} from "../run-admission.js";
import { runtimeLimitsRoutes } from "./routes.js";
import { runtimeLimitsService, type RuntimeLimitsServiceDeps } from "./service.js";

export { runtimeLimitsService, RUNTIME_LIMITS_ACTION } from "./service.js";
export type {
  RuntimeLimitsActor,
  RuntimeLimitsService,
  RuntimeLimitsView,
} from "./service.js";

function defaultDeps(db: Db): RuntimeLimitsServiceDeps {
  const heartbeat = heartbeatService(db);
  return {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: applyRunAdmissionLimits,
    // myrmidon(1.6.5 rc.2): the GET view carries the live host CPU reading, so
    // the settings page can show the load the ceiling is measured on.
    hostLoad: () => currentHostCpuGate(),
    // myrmidon(1.6.5 RUN-FAIRNESS): the GET view also carries the queue
    // snapshot — runs in flight against the ceiling and the oldest waiter.
    queueSnapshot: async () => {
      const admission = sharedRunAdmission();
      const [row] = await db
        .select({
          running: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running')`,
          queued: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'queued')`,
        })
        .from(heartbeatRuns);
      const [oldest] = await db
        .select({ createdAt: heartbeatRuns.createdAt, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "queued"))
        .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
        .limit(1);
      return {
        active: Number(row?.running ?? 0),
        limit: admission.limits().maxConcurrentRuns,
        queued: Number(row?.queued ?? 0),
        oldestQueuedAt: oldest ? oldest.createdAt.toISOString() : null,
        oldestQueuedAgentId: oldest ? oldest.agentId : null,
      };
    },
    scheduleResweep: () =>
      scheduleQueuedResweep(() =>
        heartbeat.resumeQueuedRuns().catch((err) => {
          logger.error({ err }, "queued run resweep after a runtime limits change failed");
        }),
      ),
  };
}

/** Router for app.ts: GET/PATCH /api/myrmidon/runtime-limits. */
export function myrmidonRuntimeLimitsRoutes(db: Db) {
  return runtimeLimitsRoutes(db, runtimeLimitsService(db, defaultDeps(db)));
}

/**
 * Startup: put the stored run admission limits in force. A failed read must
 * not stop the server: the admission keeps the environment values it was
 * created with, which is exactly the pre-feature behaviour.
 */
export async function startRuntimeLimits(db: Db): Promise<void> {
  try {
    const view = await runtimeLimitsService(db, defaultDeps(db)).read();
    applyRunAdmissionLimits(view.limits);
    logger.info(
      { limits: view.limits, sources: view.sources },
      "run admission limits at startup",
    );
  } catch (err) {
    logger.error(
      { err },
      "failed to read the stored run admission limits; the environment values stay in force",
    );
  }
}