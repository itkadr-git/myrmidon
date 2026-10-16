// server/src/myrmidon/channel-settings/index.ts
//
// myrmidon(1.7-SETTINGS-TO-UI) entry point: the channel settings router for
// app.ts, built over the real instance-settings service. The document and its
// resolver live in settings.ts, the read/update service in service.ts.

import type { Db } from "@paperclipai/db";
import { channelSettingsRoutes } from "./routes.js";
import { channelSettingsService } from "./service.js";

export {
  channelSettingsService,
  CHANNEL_SETTINGS_ACTION,
  CHANNEL_SETTINGS_GENERAL_KEY,
} from "./service.js";
export type {
  ChannelSettingsActor,
  ChannelSettingsService,
  ChannelSettingsServiceDeps,
} from "./service.js";
export {
  getEffectiveChannelSettings,
  parseChannelSettingsPatch,
  readStoredChannelSettings,
} from "./settings.js";
export type {
  ChannelSettingKey,
  ChannelSettingValue,
  ChannelSettings,
  ChannelSettingsDocument,
  ChannelSettingsPatch,
  SettingSource,
} from "./settings.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/channel-settings. */
export function myrmidonChannelSettingsRoutes(db: Db) {
  return channelSettingsRoutes(db, channelSettingsService(db));
}