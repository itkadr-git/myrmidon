// server/src/myrmidon/bot-containers/fleet-site-wiring.ts
//
// myrmidon(1.6.6 OPE-8999): binds the site enroll routes to the registry and company secrets.

import type { Router } from "express";
import type { Db } from "@myrmidon/db";
import { secretService } from "../../services/index.js";
import { fleetSiteRoutes } from "./fleet-site-routes.js";
import { siteHealthStore } from "./site-health-store.js";
import { createFleetSite, deleteFleetSite, getFleetSite, listFleetSites } from "./site-registry.js";

export function myrmidonFleetSiteRoutes(db: Db): Router {
  const secrets = secretService(db);
  const health = siteHealthStore(db);
  return fleetSiteRoutes({
    listSites: (companyId) => listFleetSites(db, companyId),
    getSite: (companyId, name) => getFleetSite(db, companyId, name),
    createSite: (input) => createFleetSite(db, input),
    deleteSite: (companyId, name) => deleteFleetSite(db, companyId, name),
    countBotsOnSite: async (companyId, name) => (await health.listBotsOnSite(companyId, name)).length,
    readSecret: async (companyId, name) => {
      const secret = await secrets.getByName(companyId, name);
      return secret ? secrets.resolveSecretValue(companyId, secret.id, "latest") : null;
    },
    secretExists: async (companyId, name) => Boolean(await secrets.getByName(companyId, name)),
  });
}
