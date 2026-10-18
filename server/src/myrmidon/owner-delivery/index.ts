// server/src/myrmidon/owner-delivery/index.ts
//
// myrmidon(1.6.5-OWNER-DM-FILTER): the wiring point of the owner-DM delivery
// filter. app.ts mounts `myrmidonOwnerDeliveryRoutes` from here; the shared
// contract (settings shape, mode decision) lives in `@paperclipai/shared`.

import type { Db } from "@paperclipai/db";
import { ownerDeliveryRoutes } from "./routes.js";

export * from "./settings.js";
export * from "./owner-card-text.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/owner-delivery. */
export function myrmidonOwnerDeliveryRoutes(db: Db) {
  return ownerDeliveryRoutes(db);
}
