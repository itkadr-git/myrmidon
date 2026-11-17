// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSettingsView } from "@myrmidon/shared";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), patch: vi.fn(), company: { id: "A" as string | null } }));
vi.mock("./knowledgeSettingsApi", () => ({
  fetchKnowledgeSettings: (...args: unknown[]) => mocks.fetch(...args),
  patchKnowledgeSettings: (...args: unknown[]) => mocks.patch(...args),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.company.id }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const view = (value: number): KnowledgeSettingsView => ({
  maxItems: { value, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
});

async function settle() { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("KnowledgeSettingsScreen company switch", () => {
  let container: HTMLDivElement;
  let client: QueryClient;
  let root: ReturnType<typeof createRoot>;
  const element = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const input = () => element("knowledge-max-items") as HTMLInputElement;
  const save = () => element("knowledge-settings-save") as HTMLButtonElement;
  async function render(id: string | null) {
    mocks.company.id = id;
    flushSync(() => root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>));
    await settle();
  }
  async function edit(value: string) {
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  }
  async function clickSave() { flushSync(() => save().click()); await settle(); }

  beforeEach(() => {
    mocks.fetch.mockReset(); mocks.patch.mockReset(); mocks.company.id = "A";
    container = document.createElement("div"); document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    root = createRoot(container);
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });

  it("discards A's dirty draft and saves only B's edited value", async () => {
    mocks.fetch.mockImplementation(async (id: string) => view(id === "A" ? 5000 : 6000));
    mocks.patch.mockResolvedValue(view(7000));
    await render("A"); await edit("5500");
    expect(save().disabled).toBe(false);
    await render("B");
    expect(input().value).toBe("6000");
    expect(save().disabled).toBe(true);
    await edit("7000"); await clickSave();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith("B", { maxItems: "7000" });
    expect(input().value).toBe("7000");
    expect(element("knowledge-settings-saved")).not.toBeNull();
  });

  it("does not carry save success or failure to another company", async () => {
    mocks.fetch.mockImplementation(async (id: string) => view(id === "A" ? 5000 : 6000));
    mocks.patch.mockResolvedValueOnce(view(5500)).mockRejectedValueOnce(new Error("save failed"));
    await render("A"); await edit("5500"); await clickSave();
    expect(element("knowledge-settings-saved")).not.toBeNull();
    await render("B");
    expect(element("knowledge-settings-saved")).toBeNull();
    await edit("6500"); await clickSave();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("knowledgeSettings.saveError");
    await render("A");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(element("knowledge-settings-saved")).toBeNull();
  });

  it("ignores a late A save after switching to B", async () => {
    let resolveSave!: (value: KnowledgeSettingsView) => void;
    mocks.fetch.mockImplementation(async (id: string) => view(id === "A" ? 5000 : 6000));
    mocks.patch.mockImplementation(() => new Promise<KnowledgeSettingsView>((resolve) => { resolveSave = resolve; }));
    await render("A"); await edit("5500"); await clickSave();
    expect(mocks.patch).toHaveBeenCalledWith("A", { maxItems: "5500" });
    await render("B"); await edit("6500");
    resolveSave(view(5500)); await settle();
    expect(input().value).toBe("6500");
    expect(element("knowledge-settings-saved")).toBeNull();
    expect(save().disabled).toBe(false);
  });

  it("handles no company and ignores a late A fetch after switching to B", async () => {
    let resolveA!: (value: KnowledgeSettingsView) => void;
    mocks.fetch.mockImplementation((id: string) => id === "A" ? new Promise<KnowledgeSettingsView>((resolve) => { resolveA = resolve; }) : Promise.resolve(view(6000)));
    await render(null);
    expect(element("knowledge-settings-no-company")).not.toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await render("A");
    expect(element("knowledge-settings-loading")).not.toBeNull();
    await render("B");
    expect(input().value).toBe("6000");
    resolveA(view(5000)); await settle();
    expect(input().value).toBe("6000");
    expect(save().disabled).toBe(true);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
