// Live progress steps in the bridged Telegram DM status message
// (myrmidon DM-PROGRESS) entry point.
//
// Router for app.ts: GET/PATCH /api/myrmidon/telegram-dm-progress. The
// settings are read by the milestone sweep (a few seconds of cache at most),
// so there is no startup apply step.

import type { Db } from "@paperclipai/db";
import { telegramDmProgressRoutes } from "./routes.js";
import { telegramDmProgressService } from "./service.js";

export {
  telegramDmProgressService,
  TELEGRAM_DM_PROGRESS_ACTION,
  type TelegramDmProgressActor,
  type TelegramDmProgressService,
  type TelegramDmProgressView,
} from "./service.js";
export {
  readTelegramDmProgressSettings,
  invalidateTelegramDmProgressSettingsCache,
  preserveTelegramDmProgressGeneralKey,
  TELEGRAM_DM_PROGRESS_SETTINGS_KEY,
} from "./settings.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/telegram-dm-progress. */
export function myrmidonTelegramDmProgressRoutes(db: Db) {
  return telegramDmProgressRoutes(db, telegramDmProgressService(db));
}
