// myrmidon(1.6.6 CH-CONNECTOR-D): the bridged-DM settings theme.
//
// The core imports the theme from here instead of
// `agent-chat-bridge/settings.js`, so a registered channel connector can serve
// the two switches the bridged DM is gated by; without one the legacy module
// answers (fail-open).
import * as legacy from "../../agent-chat-bridge/settings.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("agent-chat-bridge/settings", legacy);

export const telegramDmConversationsConfigured: typeof legacy.telegramDmConversationsConfigured =
  (...args) => theme().telegramDmConversationsConfigured(...args);

export const telegramDmConversationsEnabled: typeof legacy.telegramDmConversationsEnabled =
  (...args) => theme().telegramDmConversationsEnabled(...args);