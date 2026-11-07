// myrmidon(1.6.6 CH-CONNECTOR-D): the @<alias> addressing theme of the bridge.
//
// The core imports the theme from here instead of
// `agent-chat-bridge/addressing.js`, so a registered channel connector can
// serve the addressee resolution and the leading-token strip; without one the
// legacy module answers (fail-open).
import * as legacy from "../../agent-chat-bridge/addressing.js";
import type { TelegramAddressee } from "../../agent-chat-bridge/addressing.js";
import { channelBridgeTheme } from "./themes.js";

export type { TelegramAddressee };

const theme = () => channelBridgeTheme("agent-chat-bridge/addressing", legacy);

export const stripLeadingMentionToken: typeof legacy.stripLeadingMentionToken =
  (...args) => theme().stripLeadingMentionToken(...args);