// server/src/myrmidon/agent-exchange/settings.myrmidon.test.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-A): the settings reader — the precedence the
// settings screen promises ("значение и откуда оно взялось"): the stored
// value wins over the environment, the environment over the default, and a
// read failure fails safe-closed (the master switch off).

import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_EXCHANGE_SETTINGS, AGENT_EXCHANGE_ENV_KEYS } from "@paperclipai/shared";
import { readAgentExchangeSettings } from "./settings.js";

function deps(stored: unknown, env: Record<string, string> = {}) {
  return { getGeneral: async () => ({ agentExchange: stored }), env };
}

describe("agent-exchange settings (myrmidon 1.7 AGENT-EXCHANGE-A)", () => {
  it("defaults to the feature off with every key sourced from the default", async () => {
    const resolved = await readAgentExchangeSettings(deps(undefined));
    expect(resolved.settings).toEqual(DEFAULT_AGENT_EXCHANGE_SETTINGS);
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe("default");
    expect(resolved.sources.tokenBudget).toBe("default");
  });

  it("the stored value wins over the environment", async () => {
    const resolved = await readAgentExchangeSettings(
      deps(
        { ...DEFAULT_AGENT_EXCHANGE_SETTINGS, enabled: true, maxRounds: 2 },
        { [AGENT_EXCHANGE_ENV_KEYS.maxRounds]: "7" },
      ),
    );
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.sources.enabled).toBe("settings");
    expect(resolved.settings.maxRounds).toBe(2);
    expect(resolved.sources.maxRounds).toBe("settings");
  });

  it("the environment overrides the default and reports itself as the source", async () => {
    const resolved = await readAgentExchangeSettings(
      deps(undefined, {
        [AGENT_EXCHANGE_ENV_KEYS.enabled]: "true",
        [AGENT_EXCHANGE_ENV_KEYS.tokenBudget]: "50000",
      }),
    );
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.sources.enabled).toBe("env");
    expect(resolved.settings.tokenBudget).toBe(50_000);
    expect(resolved.sources.tokenBudget).toBe("env");
  });

  it("a broken stored blob falls back to defaults instead of crashing", async () => {
    const resolved = await readAgentExchangeSettings(deps({ enabled: "yes" }));
    expect(resolved.settings).toEqual(DEFAULT_AGENT_EXCHANGE_SETTINGS);
  });

  it("a settings read failure fails safe-closed", async () => {
    const resolved = await readAgentExchangeSettings({
      getGeneral: async () => {
        throw new Error("db down");
      },
      env: {},
    });
    expect(resolved.settings.enabled).toBe(false);
  });
});
