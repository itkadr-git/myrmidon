// myrmidon(1.6.6 CH-CONNECTOR-D): the notify settings-store theme of the Telegram channel.
//
// The instance-settings preservation of the notify settings key is reached
// from here instead of `telegram-notify/settings-store.js`, so a registered
// channel connector can serve it; without one the legacy module answers
// (fail-open).
import * as legacy from "../../telegram-notify/settings-store.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () =>
  channelBridgeTheme("telegram-notify/settings-store", legacy);

export const preserveTelegramNotifySettingsGeneralKey: typeof legacy.preserveTelegramNotifySettingsGeneralKey =
  (...args) => theme().preserveTelegramNotifySettingsGeneralKey(...args);
