// myrmidon(1.7 USERS-ADMIN-UI A) entry point: admin-managed board users.
//
// Routes are stateless — the blocklist and the self-registration switch live
// in instance_settings.general and are read live per request, so nothing is
// held in memory here and no startup step is needed.

import type { Db } from "@paperclipai/db";
import { usersAdminRoutes } from "./routes.js";

export * from "./service.js";
export * from "./store.js";

/** Router for app.ts: /api/myrmidon/users-admin-a/*. */
export function myrmidonUsersAdminRoutes(db: Db) {
  return usersAdminRoutes(db);
}
