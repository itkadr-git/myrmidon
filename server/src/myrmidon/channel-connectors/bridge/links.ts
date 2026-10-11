// myrmidon(1.6.6 CH-CONNECTOR-D): the board-link theme of the bridge.
//
// The core imports the theme from here instead of
// `agent-chat-bridge/links.js`, so a registered channel connector can serve the
// per-endpoint board links and the addressed reply prefix; without one the
// legacy module answers (fail-open).
import * as legacy from "../../agent-chat-bridge/links.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("agent-chat-bridge/links", legacy);

export const absolutizedTextByTelegramEndpoint: typeof legacy.absolutizedTextByTelegramEndpoint =
  (...args) => theme().absolutizedTextByTelegramEndpoint(...args);

export const addressedReplyPrefixByTelegramEndpoint: typeof legacy.addressedReplyPrefixByTelegramEndpoint =
  (...args) => theme().addressedReplyPrefixByTelegramEndpoint(...args);