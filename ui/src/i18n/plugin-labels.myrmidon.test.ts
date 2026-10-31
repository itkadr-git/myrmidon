// myrmidon(OPE-9352): plugin-name localization helper.
import { describe, expect, it } from "vitest";
import en from "./myrmidon-locales/en.json";
import ru from "./myrmidon-locales/ru.json";
import { pluginLabel, pluginLabelKey } from "./plugin-labels";

function translator(catalog: Record<string, unknown>) {
  return (key: string, options?: { defaultValue?: string }) => {
    let node: unknown = catalog;
    for (const part of key.split(".")) {
      node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
    }
    return typeof node === "string" ? node : (options?.defaultValue ?? key);
  };
}

describe("pluginLabel", () => {
  it("builds the catalog key with dots in the plugin key replaced", () => {
    expect(pluginLabelKey("myrmidon.personal-bot", null)).toBe("pluginLabels.myrmidon_personal-bot._plugin");
    expect(pluginLabelKey("myrmidon.personal-bot", "personal-bot-page")).toBe(
      "pluginLabels.myrmidon_personal-bot.personal-bot-page",
    );
  });

  it("returns Russian names for known plugins in ru", () => {
    const t = translator(ru);
    expect(pluginLabel(t, "myrmidon.personal-bot", null, "Personal bot")).toBe("Персональный бот");
    expect(pluginLabel(t, "myrmidon.license-issuer", "license-issuer-sidebar", "License issuing")).toBe("Выпуск лицензий");
    expect(pluginLabel(t, "myrmidon.chatgpt-pool", "chatgpt-pool-page", "ChatGPT subscriptions")).toBe("Подписки ChatGPT");
    expect(pluginLabel(t, "myrmidon.google-ai", null, "Google AI Pro")).toBe("Google AI Pro");
    expect(pluginLabel(t, "myrmidon.google-ai", "google-ai-sidebar", "Google AI Pro")).toBe("Google AI Pro");
    expect(pluginLabel(t, "myrmidon.google-ai", "google-ai-page", "Google AI Pro")).toBe("Google AI Pro");
    expect(pluginLabel(t, "myrmidon.antigravity", null, "Antigravity")).toBe("Antigravity");
    expect(pluginLabel(t, "myrmidon.antigravity", "antigravity-sidebar", "Antigravity")).toBe("Antigravity");
    expect(pluginLabel(t, "myrmidon.antigravity", "antigravity-page", "Antigravity")).toBe("Antigravity");
  });

  it("returns the English name in en", () => {
    expect(pluginLabel(translator(en), "myrmidon.chatgpt-pool", null, "ChatGPT subscriptions")).toBe("ChatGPT subscriptions");
  });

  it("returns the manifest text for unknown plugins, ids and missing keys", () => {
    const t = translator(ru);
    expect(pluginLabel(t, "myrmidon.google-ai", null, "Google AI Pro")).toBe("Google AI Pro");
    expect(pluginLabel(t, "myrmidon.personal-bot", "no-such-slot", "Whatever")).toBe("Whatever");
    expect(pluginLabel(t, undefined, null, "Fallback")).toBe("Fallback");
  });
});
