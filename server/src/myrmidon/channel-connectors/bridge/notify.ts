// myrmidon(1.6.6 CH-CONNECTOR-D): the notify jobs theme of the Telegram channel.
//
// The core reaches the notify track's entry point from here instead of
// `telegram-notify/index.js`, so a registered channel connector can serve the
// digest/escalation jobs, the errors-channel sweep starter and the owner
// settings routes; without one the legacy module answers (fail-open).
import * as legacy from "../../telegram-notify/index.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("telegram-notify/index", legacy);

export const startTelegramNotifyJobs: typeof legacy.startTelegramNotifyJobs =
  (...args) => theme().startTelegramNotifyJobs(...args);

export const startTgNotifySweep: typeof legacy.startTgNotifySweep =
  (...args) => theme().startTgNotifySweep(...args);

export const dbErrorChannelSettingsSource: typeof legacy.dbErrorChannelSettingsSource =
  (...args) => theme().dbErrorChannelSettingsSource(...args);

export const myrmidonTelegramNotifyRoutes: typeof legacy.myrmidonTelegramNotifyRoutes =
  (...args) => theme().myrmidonTelegramNotifyRoutes(...args);
