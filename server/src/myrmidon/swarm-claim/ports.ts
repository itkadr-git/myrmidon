// server/src/myrmidon/swarm-claim/ports.ts
//
// myrmidon(1.6-SWARM): the ports object the app, the startup and the event
// paths hand around. Split out of index.ts so the matcher factory and the claim
// service can use it without importing the wiring point (no import cycle).

import type { Db } from "@paperclipai/db";
import type { CompanyCastesReader } from "@paperclipai/shared";
import { logActivity as logActivityService } from "../../services/activity-log.js";
import type { instanceSettingsService } from "../../services/instance-settings.js";
import type { SwarmClaimEnqueueWakeup, SwarmClaimServicePorts } from "./service.js";

export interface SwarmClaimPorts {
  db: Db;
  settings: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral" | "updateGeneral">;
  enqueueWakeup?: SwarmClaimEnqueueWakeup;
  /** The company caste directory (T3 port): the claim gate, the sweeper and the matcher read it. */
  castes?: CompanyCastesReader;
  env?: Record<string, string | undefined>;
}

/** Build the ports object once (app.ts / the startup both call this). */
export function swarmClaimPorts(
  ports: Omit<SwarmClaimPorts, "settings"> & { settings: Pick<SwarmClaimPorts["settings"], "getGeneral"> },
): SwarmClaimServicePorts {
  return {
    db: ports.db,
    settings: ports.settings,
    enqueueWakeup: ports.enqueueWakeup,
    castes: ports.castes,
    logActivity: async (input) => {
      await logActivityService(ports.db, {
        companyId: input.companyId,
        actorType: input.actorType as "user" | "agent" | "system",
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        details: input.details,
      });
    },
    env: ports.env,
  };
}
