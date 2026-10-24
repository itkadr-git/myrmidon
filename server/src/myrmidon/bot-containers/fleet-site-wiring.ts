// server/src/myrmidon/bot-containers/fleet-site-wiring.ts
//
// myrmidon(1.6.6 OPE-8999): binds the site enroll routes to the registry and company secrets.

import type { Router } from "express";
import type { Db } from "@myrmidon/db";
import { secretService } from "../../services/index.js";
import { fleetSiteRoutes } from "./fleet-site-routes.js";
import { createFleetSite, deleteFleetSite, getFleetSite, listFleetSites } from "./site-registry.js";

export function myrmidonFleetSiteRoutes(db: Db): Router {
  const secrets = secretService(db);
  return fleetSiteRoutes({
    listSites: (companyId) => listFleetSites(db, companyId),
    getSite: (companyId, name) => getFleetSite(db, companyId, name),
    createSite: (input) => createFleetSite(db, input),
    deleteSite: (companyId, name) => deleteFleetSite(db, companyId, name),
    secretExists: async (companyId, name) => Boolean(await secrets.getByName(companyId, name)),
  });
}
