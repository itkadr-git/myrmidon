// myrmidon(1.6.6 CH-CONNECTOR-D): the bridged-DM theme of the bridge.
//
// The core imports the theme from here instead of
// `agent-chat-bridge/bridge.js`, so a registered channel connector can serve
// the addressee lookup and the DM binding commands; without one the legacy
// module answers (fail-open).
import * as legacy from "../../agent-chat-bridge/bridge.js";
import type { TelegramDmBridgeDeps } from "../../agent-chat-bridge/bridge.js";
import { channelBridgeTheme } from "./themes.js";

export type { TelegramDmBridgeDeps };

const theme = () => channelBridgeTheme("agent-chat-bridge/bridge", legacy);

export const resolveBridgedAddressee: typeof legacy.resolveBridgedAddressee =
  (...args) => theme().resolveBridgedAddressee(...args);

export const decideTelegramDmBinding: typeof legacy.decideTelegramDmBinding =
  (...args) => theme().decideTelegramDmBinding(...args);

export const ensureTelegramDmBinding: typeof legacy.ensureTelegramDmBinding =
  (...args) => theme().ensureTelegramDmBinding(...args);

export const handleTelegramDmCommand: typeof legacy.handleTelegramDmCommand =
  (...args) => theme().handleTelegramDmCommand(...args);

export const refuseUnlinkedTelegramDm: typeof legacy.refuseUnlinkedTelegramDm =
  (...args) => theme().refuseUnlinkedTelegramDm(...args);

export const afterTelegramDmMessage: typeof legacy.afterTelegramDmMessage =
  (...args) => theme().afterTelegramDmMessage(...args);