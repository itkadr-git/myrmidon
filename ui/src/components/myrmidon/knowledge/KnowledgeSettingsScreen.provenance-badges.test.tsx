// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSettingsView } from "@myrmidon/shared";
import en from "@/i18n/myrmidon-locales/en.json";
import ru from "@/i18n/myrmidon-locales/ru.json";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), patch: vi.fn(), locale: "en" }));
vi.mock("./knowledgeSettingsApi", () => ({
  fetchKnowledgeSettings: (...args: unknown[]) => mocks.fetch(...args),
  patchKnowledgeSettings: (...args: unknown[]) => mocks.patch(...args),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/i18n", () => {
  return { useTranslation: () => ({ t: (key: string) => {
    const prefix = "knowledgeSettings.";
    if (!key.startsWith(prefix)) return key;
    const entries: Record<string, string> = (mocks.locale === "ru" ? ru : en).knowledgeSettings;
    return entries[key.slice(prefix.length)] ?? key;
  } }) };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const view: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "env" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "ui" },
  autoAcceptMinConfidence: { value: "0.9", source: "env" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "ui" },
};

const fields = [
  ['label[for="knowledge-max-items"]', "maxItems"],
  ['label[for="knowledge-max-bytes"]', "maxRevisionBytes"],
  ['label[for="knowledge-auto-accept"]', "autoAcceptEnabled"],
  ['label[for="knowledge-confidence"]', "autoAcceptMinConfidence"],
  ['label[for="knowledge-schedule"]', "schedule"],
  ['[data-testid="knowledge-reviewers"] h2', "sectionReviewers"],
] as const;

describe("Knowledge settings provenance", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.patch.mockReset();
    mocks.locale = "en";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    mocks.fetch.mockResolvedValue(view);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });

  async function settle() {
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
  }

  async function render() {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>);
    });
    await settle();
  }

  function expectSources(expected: KnowledgeSettingsView, locale: typeof en) {
    for (const [selector, field] of fields) {
      const badge = container.querySelector(`${selector} [data-testid="knowledge-source-badge"]`);
      const source = expected[field].source;
      expect(badge, selector).not.toBeNull();
      expect(badge?.getAttribute("data-source"), selector).toBe(source);
      expect(badge?.textContent, selector).toBe(locale.knowledgeSettings[`source.${source}`]);
    }
  }

  it.each([["en", en], ["ru", ru]] as const)("shows each field's own translated source in %s", async (language, locale) => {
    mocks.locale = language;
    await render();
    expectSources(view, locale);
  });

  it("keeps server provenance during a save and uses the returned view after success", async () => {
    let resolvePatch: (value: KnowledgeSettingsView) => void = () => { throw new Error("Patch promise not initialized"); };
    const pending = new Promise<KnowledgeSettingsView>((resolve) => { resolvePatch = resolve; });
    mocks.patch.mockReturnValue(pending);
    await render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-items"]');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "7000");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expectSources(view, en);
    const save = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]');
    expect(save?.disabled).toBe(false);
    await act(async () => { save?.click(); });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith("company-1", { maxItems: "7000" });
    expectSources(view, en);
    const updated: KnowledgeSettingsView = { ...view, maxItems: { value: 7000, source: "ui" } };
    await act(async () => { resolvePatch(updated); });
    await settle();
    expectSources(updated, en);
  });
});
