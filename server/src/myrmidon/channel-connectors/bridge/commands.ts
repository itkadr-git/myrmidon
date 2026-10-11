// myrmidon(1.6.6 CH-CONNECTOR-D): the DM command menu theme of the bridge.
//
// The command menu of the bridged Telegram DM is reached from here instead of
// `agent-chat-bridge/commands/index.js`, so a registered channel connector can
// serve the canonical command list and the per-locale menu; without one the
// legacy module answers (fail-open).
//
// The two exports here carry a fixed value (the list, and the copy that hashes
// into the menu-registration version). A connector replaces *behaviour*, not
// the contract's canonical text: the constants below stay on the legacy
// module's value even when the flag is on, so a half-written connector cannot
// desynchronise `telegramCommandsCopyVersion` in chat-channels.ts from the
// list it registers.
import * as legacy from "../../agent-chat-bridge/commands/index.js";
import type { BridgedCommandSpec } from "../../agent-chat-bridge/commands/index.js";
import { channelBridgeTheme } from "./themes.js";

export type { BridgedCommandSpec };

const theme = () => channelBridgeTheme("agent-chat-bridge/commands", legacy);

/** The canonical bridged-DM command list (contract X8a; tests hash it). */
export const TELEGRAM_DM_COMMANDS: readonly BridgedCommandSpec[] =
  legacy.TELEGRAM_DM_COMMANDS;

export const telegramDmCommandsForLocale: typeof legacy.telegramDmCommandsForLocale =
  (...args) => theme().telegramDmCommandsForLocale(...args);
