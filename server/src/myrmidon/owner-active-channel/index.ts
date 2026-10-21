// Owner active channel (myrmidon 1.7-ACTIVE-CHANNEL) entry point.
//
// Route mount for app.ts: GET/PATCH /api/myrmidon/owner/active-channel.
// The activity store itself needs no startup step — the touch points write it
// (middleware/auth.ts for the portal, chat-channels.ts for Telegram) and the
// readers (the route, the owner-delivery gate) read it on demand.

import type { Db } from "@paperclipai/db";
import { ownerActiveChannelService } from "./service.js";
import { ownerActiveChannelRoutes } from "./routes.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/owner/active-channel. */
export function myrmidonOwnerActiveChannelRoutes(db: Db) {
  return ownerActiveChannelRoutes(db, ownerActiveChannelService(db));
}

export { telegramOwnerDeliveryBindings } from "./owner-delivery-gate.js";
export { markOwnerActivity, touchWebActivityBestEffort, resolveOwnerActiveChannel, readOwnerActivity } from "./store.js";
export { readOwnerActiveChannelSettings, preserveOwnerActiveChannelGeneralKey, OWNER_ACTIVE_CHANNEL_SETTINGS_KEY } from "./settings.js";
export { ownerActiveChannelService, OWNER_ACTIVE_CHANNEL_ACTION } from "./service.js";
