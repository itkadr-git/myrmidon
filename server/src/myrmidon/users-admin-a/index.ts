// myrmidon(OPE-8985): users-admin-a entry point. Stateless: nothing is held in
// memory and there is no startup step.
import type { Db } from "@paperclipai/db";
import { usersAdminRoutes, type UsersAdminRoutesOptions } from "./routes.js";

export * from "./service.js";

/** Router for app.ts: /api/myrmidon/users-admin-a/*. */
export function myrmidonUsersAdminRoutes(db: Db, opts: UsersAdminRoutesOptions = {}) {
  return usersAdminRoutes(db, opts);
}
