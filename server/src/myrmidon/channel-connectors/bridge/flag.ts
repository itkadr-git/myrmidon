// myrmidon(1.6.6 CH-CONNECTOR-D): the flag of the bridge adapter seam.
//
// Every bridge theme of the Telegram channel (addressing, cross-channel
// context, board links, topic inbound, voice intake, DM identity) is reached by
// the core through `channel-connectors/bridge/*` instead of the bridge module
// directly. The seam is where a channel connector takes a theme over:
//
//  * `off` (the default) — every symbol is the legacy bridge module, so the
//    behaviour of the core is exactly the one of main;
//  * `on` — a registered connector replaces the symbols it serves and keeps
//    the rest on the legacy module (fail-open, design section 7).
//
// Read per call, like every other myrmidon setting: flipping the value needs a
// restart of the server, not a rebuild.

export const CHANNEL_BRIDGE_ADAPTER_ENV = "MYRMIDON_CHANNEL_CONNECTOR_BRIDGE";

/**
 * Whether the bridge themes are served by the channel connector when one is
 * registered. Off by default: a deployment value, the operator enables it once
 * the connector ships.
 */
export function channelBridgeAdapterEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[CHANNEL_BRIDGE_ADAPTER_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}