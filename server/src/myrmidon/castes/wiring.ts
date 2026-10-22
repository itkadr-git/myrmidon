// server/src/myrmidon/castes/wiring.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES A): binds the caste routes to the database and
// the company activity log. Kept apart from routes.ts so the routes stay
// testable with plain fakes; this file is the only one that knows about `Db`.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logActivity } from "../../services/index.js";
import { casteRoutes, type CasteRoutesDeps } from "./routes.js";
import { createCasteService, type CasteActivityEntry } from "./service.js";
import { createCasteStore } from "./store.js";
import { agentNestRoutes, type AgentNestActivityEntry } from "./nests-routes.js";
import { createAgentNestService } from "./nests-service.js";
import { createAgentNestStore } from "./nests-store.js";

/** The activity row of one caste mutation (create / update / remove). */
export async function recordCasteActivity(db: Db, entry: CasteActivityEntry): Promise<void> {
  await logActivity(db, {
    companyId: entry.companyId,
    actorType: "user",
    actorId: "board",
    action: entry.action,
    entityType: "caste",
    entityId: entry.casteKey,
    details: entry.details,
  });
}

/** The activity row of one nests save (1.6.5 F-26 T3). */
export async function recordAgentNestActivity(
  db: Db,
  entry: AgentNestActivityEntry,
): Promise<void> {
  await logActivity(db, {
    companyId: entry.companyId,
    actorType: "user",
    actorId: "board",
    action: "agent_nests_updated",
    entityType: "agent",
    entityId: entry.agentId,
    details: { projectIds: entry.projectIds, added: entry.added, removed: entry.removed },
  });
}

export function myrmidonCasteRoutes(db: Db): Router {
  const store = createCasteStore({ db });
  const deps: CasteRoutesDeps = {
    service: createCasteService({ db, store }),
    recordActivity: (entry) => recordCasteActivity(db, entry),
  };
  const router = casteRoutes(deps);
  // 1.6.5 F-26 T3: the agent nests live in the same module and the same mount
  // point — the card writes them through PUT .../agents/:agentId/nests.
  router.use(
    agentNestRoutes({
      service: createAgentNestService({ db, store: createAgentNestStore({ db }) }),
      recordActivity: (entry) => recordAgentNestActivity(db, entry),
    }),
  );
  return router;
}
