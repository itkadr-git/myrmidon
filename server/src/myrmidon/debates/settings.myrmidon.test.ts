// myrmidon(1.7-DEBATE-ASYM-A): where the stored debate configuration lives.
// readDebateSettings applies stored > env > default without caching, the
// preserve helper keeps the key across vendor writes of `general`, and the
// family collision is reported instead of being silently dropped.

import { describe, expect, it } from "vitest";
import { DEBATE_SETTINGS_KEY, defaultDebateSettings, getModelFamily } from "@paperclipai/shared";
import { preserveDebateGeneralKey, readDebateSettings } from "./settings.js";

describe("myrmidon(1.7-DEBATE-ASYM-A): debate settings", () => {
  it("prefers the stored row over the environment override", async () => {
    const stored = {
      generator: { model: "qwen-plus-free" },
      critic: { model: "glm-4-flash-free" },
      judge: { model: "deepseek-chat-free" },
      rounds: 2,
    };
    const resolved = await readDebateSettings({
      getGeneral: async () => ({ [DEBATE_SETTINGS_KEY]: stored }),
      env: {
        MYRMIDON_DEBATE_CONFIG: JSON.stringify({
          generator: { model: "llama-3-free" },
          critic: { model: "mistral-7b-free" },
          judge: { model: "gpt-4o-mini-free" },
        }),
      },
    });
    expect(resolved.source).toBe("settings");
    expect(resolved.settings?.rounds).toBe(2);
  });

  it("falls back to the env override, then the default", async () => {
    const env = {
      MYRMIDON_DEBATE_CONFIG: JSON.stringify({
        generator: { model: "llama-3-free" },
        critic: { model: "mistral-7b-free" },
        judge: { model: "gpt-4o-mini-free" },
      }),
    };
    const fromEnv = await readDebateSettings({ getGeneral: async () => ({}), env });
    expect(fromEnv.source).toBe("env");
    expect(getModelFamily(fromEnv.settings!.generator.model)).toBe("llama");

    const fromDefault = await readDebateSettings({ getGeneral: async () => ({}), env: {} });
    expect(fromDefault.source).toBe("default");
    expect(fromDefault.settings).toEqual(defaultDebateSettings());
  });

  it("a read failure fails open to the env/default level", async () => {
    const resolved = await readDebateSettings({
      getGeneral: async () => {
        throw new Error("db down");
      },
      env: {},
    });
    expect(resolved.source).toBe("default");
    expect(resolved.settings).not.toBeNull();
  });

  it("a stored symmetric config is reported, not hidden", async () => {
    const resolved = await readDebateSettings({
      getGeneral: async () => ({
        [DEBATE_SETTINGS_KEY]: {
          generator: { model: "qwen-plus-free" },
          critic: { model: "qwen-turbo-free" },
          judge: { model: "glm-4-flash-free" },
        },
      }),
      env: {},
    });
    expect(resolved.settings).toBeNull();
    expect(resolved.problem).toContain("asymmetric");
  });

  it("the preserve helper keeps the debate key across vendor general writes", () => {
    const stored = { debate: { generator: { model: "a" } }, other: 1 };
    expect(preserveDebateGeneralKey(stored)).toEqual({ debate: { generator: { model: "a" } } });
    expect(preserveDebateGeneralKey({ other: 1 })).toEqual({});
    expect(preserveDebateGeneralKey(null)).toEqual({});
    // An explicit clear (stored null) roundtrips as null so the level drops.
    expect(preserveDebateGeneralKey({ debate: null })).toEqual({ debate: null });
  });
});
