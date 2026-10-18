import type { Db } from "@paperclipai/db";
import { fleetSiteRoutes } from "./routes.js";
import { fleetSiteStore } from "./store.js";

export function myrmidonFleetSiteRoutes(db: Db) {
  return fleetSiteRoutes({ store: fleetSiteStore(db) });
}
