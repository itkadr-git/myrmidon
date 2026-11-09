// myrmidon(1.6.6 CH-CONNECTOR-D): the proactivity policy theme of the Telegram channel.
//
// The instance-settings preservation of the notify track's general keys is
// reached from here instead of `telegram-notify/proactivity-policy.js`, so a
// registered channel connector can serve it; without one the legacy module
// answers (fail-open).
import * as legacy from "../../telegram-notify/proactivity-policy.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () =>
  channelBridgeTheme("telegram-notify/proactivity-policy", legacy);

export const preserveTelegramNotifyGeneralKey: typeof legacy.preserveTelegramNotifyGeneralKey =
  (...args) => theme().preserveTelegramNotifyGeneralKey(...args);
