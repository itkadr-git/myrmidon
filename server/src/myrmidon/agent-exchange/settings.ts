// server/src/myrmidon/agent-exchange/settings.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-A): where the discussion-room settings live and
// how they are resolved. The mode is read at request time (not cached at
// boot), so a settings-page change reaches the next room without a server
// restart; the environment stays a forced override (the same precedence
// shape BUDGET-CONFIG-B and RUNTIME-LIMITS use).
//
// A settings read failure fails SAFE-CLOSED: the shipped default has the
// master switch off, so a transient read error cannot open rooms that were
// never enabled.

import {
  AGENT_EXCHANGE_SETTINGS_KEY,
  resolveAgentExchangeSettings,
  type ResolvedAgentExchangeSettings,
} from "@paperclipai/shared";

export { AGENT_EXCHANGE_SETTINGS_KEY };

/** The deps the reader needs, so tests can run it without a database. */
export interface AgentExchangeSettingsDeps {
  getGeneral(): Promise<{ agentExchange?: unknown }>;
  env?: Record<string, string | undefined>;
}

/** The resolved settings and the per-key source map the settings screen shows. */
export async function readAgentExchangeSettings(
  deps: AgentExchangeSettingsDeps,
): Promise<ResolvedAgentExchangeSettings> {
  let stored: unknown;
  try {
    const general = await deps.getGeneral();
    stored = general?.[AGENT_EXCHANGE_SETTINGS_KEY];
  } catch {
    stored = undefined;
  }
  return resolveAgentExchangeSettings({ stored, env: deps.env ?? process.env });
}
