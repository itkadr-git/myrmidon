// myrmidon(1.6.6 CH-CONNECTOR-D): the topic-inbound settings theme of the bridge.
//
// The core imports the theme from here instead of
// `telegram-notify/topic-inbound-settings.js`, so a registered channel
// connector can serve the reader of the `inbound` settings area; without one
// the legacy module answers (fail-open).
import * as legacy from "../../telegram-notify/topic-inbound-settings.js";
import type { TelegramNotifyInboundSettings } from "../../telegram-notify/topic-inbound-settings.js";
import { channelBridgeTheme } from "./themes.js";

export type { TelegramNotifyInboundSettings };

const theme = () =>
  channelBridgeTheme("telegram-notify/topic-inbound-settings", legacy);

export const readTelegramNotifyInbound: typeof legacy.readTelegramNotifyInbound =
  (...args) => theme().readTelegramNotifyInbound(...args);