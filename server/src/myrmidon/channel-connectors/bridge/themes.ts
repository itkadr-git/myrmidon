// myrmidon(1.6.6 CH-CONNECTOR-D): the bridge themes and the seam's selection.
//
// A *theme* is one bridge module of ours whose surface belongs to the Telegram
// channel connector (the call map of the design doc, section 3.3). The core
// imports the theme from `channel-connectors/bridge/<theme>.js`; this module
// decides what that import resolves to:
//
//  * the flag is off — the legacy module itself is returned: one boolean check
//    per call, no copy, no wrapper beyond the seam's own forwarding;
//  * the flag is on and the connector serves the theme — the served symbols are
//    spread over the legacy module once and cached, so a connector that serves
//    only part of a theme cannot break the rest of it (fail-open);
//  * the flag is on and nothing serves the theme — the legacy module again.
import {
  channelBridgeAdapterEnabled,
  CHANNEL_BRIDGE_ADAPTER_ENV,
} from "./flag.js";

export { CHANNEL_BRIDGE_ADAPTER_ENV };

/** The bridge modules a connector may take over, one key per module. */
export type ChannelBridgeThemeKey =
  | "agent-chat-bridge/addressing"
  | "agent-chat-bridge/bridge"
  | "agent-chat-bridge/cross-channel"
  | "agent-chat-bridge/identity"
  | "agent-chat-bridge/links"
  | "agent-chat-bridge/locales"
  | "agent-chat-bridge/settings"
  | "telegram-notify/topic-inbound"
  | "telegram-notify/topic-inbound-settings"
  | "telegram-voice-stt-intake/index"
  | "telegram-voice-stt-intake/wiring";

/**
 * The symbols a connector serves for one theme. Every symbol left out keeps
 * the legacy implementation, so a partial theme is legal.
 */
export type ChannelBridgeThemeSource<T extends object> = Partial<T>;

const servedThemes = new Map<ChannelBridgeThemeKey, object>();
const themeFaces = new Map<ChannelBridgeThemeKey, object>();

/**
 * Teaches the seam the symbols the channel connector serves for one theme.
 * Called from the connector's registration (the hub insertion point); a theme
 * the connector does not serve is simply never declared.
 */
export function serveChannelBridgeTheme<T extends object>(
  key: ChannelBridgeThemeKey,
  source: ChannelBridgeThemeSource<T>,
): void {
  servedThemes.set(key, source as object);
  themeFaces.delete(key);
}

/**
 * Forgets every served theme, back to the "no connector" state. Registration
 * lives for the process; tests use this to start from an empty seam.
 */
export function resetChannelBridgeThemes(): void {
  servedThemes.clear();
  themeFaces.clear();
}

/** The implementation of one theme for the current call. */
export function channelBridgeTheme<T extends object>(
  key: ChannelBridgeThemeKey,
  legacy: T,
): T {
  if (!channelBridgeAdapterEnabled()) return legacy;
  const source = servedThemes.get(key);
  if (source === undefined) return legacy;
  const face = themeFaces.get(key);
  if (face !== undefined) return face as T;
  const merged = { ...legacy, ...source } as T;
  themeFaces.set(key, merged);
  return merged;
}