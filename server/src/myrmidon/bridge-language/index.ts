// Instance-wide default language of the bridged Telegram DM
// (myrmidon 1.6.5-TG-LOCALE-C) entry point.
//
// Router for app.ts: GET/PATCH /api/myrmidon/bridge-language. The value is read
// while answering a bridged message (a few seconds of cache at most), so there
// is no startup apply step.

import type { Db } from "@paperclipai/db";
import { bridgeLanguageRoutes } from "./routes.js";
import { bridgeLanguageService } from "./service.js";

export {
  bridgeLanguageService,
  BRIDGE_LANGUAGE_ACTION,
  type BridgeLanguageActor,
  type BridgeLanguageService,
  type BridgeLanguageView,
} from "./service.js";
export {
  readBridgeLanguageSettings,
  invalidateBridgeLanguageSettingsCache,
  preserveBridgeLanguageGeneralKey,
  BRIDGE_LANGUAGE_SETTINGS_KEY,
} from "./settings.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/bridge-language. */
export function myrmidonBridgeLanguageRoutes(db: Db) {
  return bridgeLanguageRoutes(db, bridgeLanguageService(db));
}