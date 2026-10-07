// server/src/myrmidon/agent-exchange/feed-settings.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-B): where the feed settings live and how they
// are resolved. Same shape as the room settings of part A: read at request
// time (never cached at boot), so a settings-page change reaches the next
// read without a server restart, and the environment stays a forced override
// for an instance that never saved its settings.
//
// A read failure falls back to the defaults instead of failing the read: the
// feed of a company must stay readable even when the settings row is
// temporarily unreadable, and `skillCandidateEnabled` defaults to on — the
// button only *proposes* a skill, the approvals pipeline still decides.

import {
  AGENT_EXCHANGE_FEED_SETTINGS_KEY,
  agentExchangeFeedSettingsSchema,
  resolveAgentExchangeFeedSettings,
  type AgentExchangeFeedSettings,
  type AgentExchangeFeedSettingsPatch,
  type ResolvedAgentExchangeFeedSettings,
} from "@paperclipai/shared";

export { AGENT_EXCHANGE_FEED_SETTINGS_KEY };

/** The deps the reader needs, so tests can run it without a database. */
export interface AgentExchangeFeedSettingsDeps {
  getGeneral(): Promise<{ agentExchangeFeed?: unknown }>;
  env?: Record<string, string | undefined>;
}

/** The resolved settings and the per-key source map the settings panel shows. */
export async function readAgentExchangeFeedSettings(
  deps: AgentExchangeFeedSettingsDeps,
): Promise<ResolvedAgentExchangeFeedSettings> {
  let stored: unknown;
  try {
    const general = await deps.getGeneral();
    stored = general?.[AGENT_EXCHANGE_FEED_SETTINGS_KEY];
  } catch {
    stored = undefined;
  }
  return resolveAgentExchangeFeedSettings({ stored, env: deps.env ?? process.env });
}

/**
 * Merge a partial patch over the effective settings. The stored blob is the
 * full object (or absent) and the PATCH body is partial, so untouched keys
 * keep the value the screen showed — not the default.
 */
export function mergeAgentExchangeFeedSettingsPatch(
  current: AgentExchangeFeedSettings,
  patch: AgentExchangeFeedSettingsPatch,
): AgentExchangeFeedSettings {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as AgentExchangeFeedSettingsPatch;
  return agentExchangeFeedSettingsSchema.parse({ ...current, ...defined });
}