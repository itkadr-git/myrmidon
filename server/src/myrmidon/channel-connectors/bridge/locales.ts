// myrmidon(1.6.6 CH-CONNECTOR-D): the bridge locale theme.
//
// The core imports the theme from here instead of
// `agent-chat-bridge/locales/index.js`, so a registered channel connector can
// serve the instance-wide forced locale of the bridged DM; without one the
// legacy module answers (fail-open).
import * as legacy from "../../agent-chat-bridge/locales/index.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("agent-chat-bridge/locales", legacy);

export const forcedBridgeLocale: typeof legacy.forcedBridgeLocale =
  (...args) => theme().forcedBridgeLocale(...args);