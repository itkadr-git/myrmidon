// server/src/myrmidon/channel-allowlist/settings.ts
//
// myrmidon(CA-A): which admission mode the general channel layer uses.
//
//   - "sponsor" (the vendor default, byte-for-byte current behavior): an
//     unlinked sender is served when the endpoint sponsors guests;
//   - "allowlist" (the owner's rule from OPE-4949): who may write to the
//     bots is decided by the board allowlist alone — a linked board member
//     writes as today, an unlinked person writes only when the allowlist
//     admits them, and nobody else is served (refusal + access card).
//
// Precedence matches every other channel setting: the environment variable
// is a forced override, the stored `instance_settings.general.channelSettings`
// document is the interface-controlled value, the built-in default is
// "sponsor" so an untouched deployment behaves exactly as before.

import { instanceSettingsService } from "../../services/instance-settings.js";
import type { Db } from "@paperclipai/db";

export type ChannelAccessMode = "sponsor" | "allowlist";

export const CHANNEL_ACCESS_MODE_ENV = "MYRMIDON_CHANNEL_ACCESS_MODE";
export const CHANNEL_ACCESS_MODE_KEY = "channelAccessMode";
export const DEFAULT_CHANNEL_ACCESS_MODE: ChannelAccessMode = "sponsor";

function parseMode(value: unknown): ChannelAccessMode | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  return raw === "sponsor" || raw === "allowlist" ? raw : null;
}

/** Pure resolution: env override, then the stored document, then the default. */
export function resolveChannelAccessMode(
  stored: unknown,
  envRaw: string | undefined,
): { mode: ChannelAccessMode; source: "env" | "ui" | "default" } {
  const fromEnv = parseMode(envRaw);
  if (fromEnv) return { mode: fromEnv, source: "env" };
  const fromStored = parseMode(stored);
  if (fromStored) return { mode: fromStored, source: "ui" };
  return { mode: DEFAULT_CHANNEL_ACCESS_MODE, source: "default" };
}

/**
 * The mode in force, read live so a board toggle applies to the next
 * message without a restart (the same re-read cadence the X8b bridge
 * settings use). The stored value sits under the same
 * `general.channelSettings.channel.channelAccessMode` key the channel
 * settings screen writes; a malformed value falls back to the default —
 * never to "allowlist", because failing closed on a config typo would
 * lock every guest out of every bot.
 */
export async function readChannelAccessMode(db: Db): Promise<ChannelAccessMode> {
  const general = (await instanceSettingsService(db).getGeneral()) as unknown as {
    channelSettings?: { channel?: Record<string, unknown> };
  };
  const stored = general?.channelSettings?.channel?.[CHANNEL_ACCESS_MODE_KEY];
  return resolveChannelAccessMode(stored, process.env[CHANNEL_ACCESS_MODE_ENV]).mode;
}
