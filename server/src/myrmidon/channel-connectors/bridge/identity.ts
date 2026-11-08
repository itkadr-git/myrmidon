// myrmidon(1.6.6 CH-CONNECTOR-D): the conversation identity theme of the bridge.
//
// The core imports the theme from here instead of
// `agent-chat-bridge/identity.js`, so a registered channel connector can serve
// the Telegram conversation key format; without one the legacy module answers
// (fail-open).
import * as legacy from "../../agent-chat-bridge/identity.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("agent-chat-bridge/identity", legacy);

export const telegramConversationUserId: typeof legacy.telegramConversationUserId =
  (...args) => theme().telegramConversationUserId(...args);

export const parseTelegramConversationUserId: typeof legacy.parseTelegramConversationUserId =
  (...args) => theme().parseTelegramConversationUserId(...args);