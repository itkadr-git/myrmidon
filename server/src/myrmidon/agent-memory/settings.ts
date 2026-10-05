// server/src/myrmidon/agent-memory/settings.ts
//
// myrmidon(MEMORY-UI): settings for the agent memory card section.
//
// The board server talks to the shared hindsight service directly (the same
// service the memory plugin and bot containers use). Like the LLM gateway
// collection (M2-A) the address and key are instance settings, not code:
// without an address the memory card answers "not enabled" instead of guessing.
// The key is optional. The instance setting general.agentMemory wins over the
// environment and is re-read on every request (no restart).

import type { AgentMemorySettings } from "@paperclipai/shared";

export const MEMORY_HINDSIGHT_API_URL_ENV = "MYRMIDON_HINDSIGHT_API_URL";
/** Same service as seen by the bot containers; the fallback address. */
export const MEMORY_BOT_HINDSIGHT_API_URL_ENV = "MYRMIDON_BOT_HINDSIGHT_API_URL";
export const MEMORY_HINDSIGHT_KEY_SECRET_ENV = "MYRMIDON_HINDSIGHT_KEY_SECRET";

export interface MemoryUiSettings {
  enabled: boolean;
  baseUrl: string | null;
  /** Name of the company secret holding the hindsight API key; null = no key is sent. */
  keySecret: string | null;
}

/** Trimmed non-empty value, or null. */
function readNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * An http(s) URL, or null when unset/invalid. An invalid non-empty value is
 * reported as null (the section then says "not enabled"), never as a crash:
 * the memory card is a read surface, and a bad setting must not take the
 * agent page down. The operator sees the reason in the section's status line.
 */
export function readHttpUrlSetting(value: string | undefined): string | null {
  const trimmed = readNonEmpty(value);
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
}

export type MemoryUrlSource = "setting" | "env" | "bot-env";

/**
 * The effective settings. Address precedence: the instance setting, then
 * MYRMIDON_HINDSIGHT_API_URL, then MYRMIDON_BOT_HINDSIGHT_API_URL (the same
 * shared service as the bots see it). The key secret is optional (a service
 * without authentication needs none); the section is on whenever an address is
 * known, unless the instance setting switches it off.
 */
export function readMemoryUiSettings(
  env: NodeJS.ProcessEnv = process.env,
  stored: AgentMemorySettings = {},
): MemoryUiSettings & { urlSource: MemoryUrlSource | null } {
  const candidates: Array<[MemoryUrlSource, string | null]> = [
    ["setting", readHttpUrlSetting(stored.apiUrl)],
    ["env", readHttpUrlSetting(env[MEMORY_HINDSIGHT_API_URL_ENV])],
    ["bot-env", readHttpUrlSetting(env[MEMORY_BOT_HINDSIGHT_API_URL_ENV])],
  ];
  const found = candidates.find(([, url]) => url !== null);
  const baseUrl = found ? found[1] : null;
  const keySecret = readNonEmpty(stored.keySecretName) ?? readNonEmpty(env[MEMORY_HINDSIGHT_KEY_SECRET_ENV]);
  return {
    enabled: stored.enabled !== false && baseUrl !== null,
    baseUrl,
    keySecret,
    urlSource: found ? found[0] : null,
  };
}
