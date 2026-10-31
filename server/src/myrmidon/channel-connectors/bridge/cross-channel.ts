// myrmidon(1.6.6 CH-CONNECTOR-D): the cross-channel context theme of the bridge.
//
// The core imports the theme from here instead of
// `agent-chat-bridge/cross-channel.js`, so a registered channel connector can
// serve the context a mentioned agent sees (the sibling channel transcript);
// without one the legacy module answers (fail-open).
import * as legacy from "../../agent-chat-bridge/cross-channel.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("agent-chat-bridge/cross-channel", legacy);

export const buildCrossChannelContext: typeof legacy.buildCrossChannelContext =
  (...args) => theme().buildCrossChannelContext(...args);

export const buildMentionedChatContext: typeof legacy.buildMentionedChatContext =
  (...args) => theme().buildMentionedChatContext(...args);

export const appendCrossChannelDelta: typeof legacy.appendCrossChannelDelta =
  (...args) => theme().appendCrossChannelDelta(...args);