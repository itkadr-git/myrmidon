// myrmidon(1.6.3-FORAGING-IDLE-GATE): the resolver contract — precedence
// (stored settings, then the environment override, then the default) and
// the source of the effective value. Pure functions, no database.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORAGING_IDLE_GATE_ENABLED,
  FORAGING_IDLE_GATE_ENABLED_ENV,
  FORAGING_IDLE_GATE_SETTINGS_KEY,
  normalizeForagingIdleGateSettings,
  parseForagingIdleGateEnabled,
  resolveForagingIdleGate,
} from "./myrmidon-foraging-idle-gate.js";

const ENV_KEY = FORAGING_IDLE_GATE_ENABLED_ENV;

describe("myrmidon(1.6.3-FORAGING-IDLE-GATE) resolver", () => {
  it("the stored settings value wins and reports source: settings", () => {
    for (const enabled of [true, false]) {
      const resolved = resolveForagingIdleGate({ stored: { enabled }, env: { [ENV_KEY]: "0" } });
      expect(resolved).toEqual({ enabled, source: "settings" });
    }
  });

  it("without a stored value the env override applies and reports source: env", () => {
    expect(resolveForagingIdleGate({ env: { [ENV_KEY]: "0" } })).toEqual({ enabled: false, source: "env" });
    expect(resolveForagingIdleGate({ env: { [ENV_KEY]: "1" } })).toEqual({ enabled: true, source: "env" });
    expect(resolveForagingIdleGate({ env: { [ENV_KEY]: "false" } })).toEqual({ enabled: false, source: "env" });
    expect(resolveForagingIdleGate({ env: { [ENV_KEY]: "true" } })).toEqual({ enabled: true, source: "env" });
  });

  it("nothing stored and nothing in the env: the default (on), source: default", () => {
    expect(resolveForagingIdleGate({})).toEqual({
      enabled: DEFAULT_FORAGING_IDLE_GATE_ENABLED,
      source: "default",
    });
    expect(DEFAULT_FORAGING_IDLE_GATE_ENABLED).toBe(true);
  });

  it("an unreadable stored value counts as absent (env/default applies)", () => {
    for (const bad of [null, 42, "on", { enabled: "yes" }, {}]) {
      expect(resolveForagingIdleGate({ stored: bad, env: {} })).toEqual({
        enabled: true,
        source: "default",
      });
    }
  });

  it("an unreadable env value counts as unset", () => {
    expect(resolveForagingIdleGate({ env: { [ENV_KEY]: "maybe" } })).toEqual({ enabled: true, source: "default" });
    expect(parseForagingIdleGateEnabled("maybe")).toBeNull();
    expect(parseForagingIdleGateEnabled(undefined)).toBeNull();
    expect(parseForagingIdleGateEnabled(" 1 ")).toBe(true);
    expect(parseForagingIdleGateEnabled("Off")).toBe(false);
  });

  it("normalizeForagingIdleGateSettings accepts only the strict shape", () => {
    expect(normalizeForagingIdleGateSettings({ enabled: true })).toEqual({ enabled: true });
    expect(normalizeForagingIdleGateSettings({ enabled: false, extra: 1 })).toBeNull();
    expect(normalizeForagingIdleGateSettings(undefined)).toBeNull();
  });

  it("exports the canonical keys", () => {
    expect(ENV_KEY).toBe("MYRMIDON_FORAGING_IDLE_GATE_ENABLED");
    expect(FORAGING_IDLE_GATE_SETTINGS_KEY).toBe("foragingIdleGate");
  });
});
