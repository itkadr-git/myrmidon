// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSettingsView } from "@myrmidon/shared";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";

const fetchMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock("./knowledgeSettingsApi", () => ({
  fetchKnowledgeSettings: (...args: unknown[]) => fetchMock(...args),
  patchKnowledgeSettings: (...args: unknown[]) => patchMock(...args),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key === "knowledgeSettings.saved" ? "Settings saved" : key }) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const reviewer = { section: "guides", reviewerKind: "user" as const, reviewerId: "user-1" };
const view: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [reviewer], source: "default" },
};
const savedView: KnowledgeSettingsView = { ...view, maxItems: { value: 7000, source: "ui" } };

describe("knowledge settings saved feedback", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
  const element = <T extends Element>(testId: string) => container.querySelector<T>(`[data-testid="${testId}"]`)!;
  const button = (text: string) => Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text)!;
  const click = async (target: HTMLElement) => { await act(async () => { target.click(); }); };
  const change = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const saveFirstChange = async () => {
    await change(element("knowledge-max-items"), "7000");
    await click(element("knowledge-settings-save"));
    await settle();
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenNthCalledWith(1, "company-1", { maxItems: "7000" });
    expect(element("knowledge-settings-saved")?.textContent).toBe("Settings saved");
  };
  beforeEach(async () => {
    fetchMock.mockReset().mockResolvedValue(view);
    patchMock.mockReset().mockResolvedValue(savedView);
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    root = createRoot(container);
    await act(async () => { root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>); });
    await settle();
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    client.clear();
    container.remove();
  });
  it("clears the saved message immediately when adding a reviewer without another PATCH", async () => {
    await saveFirstChange();
    await click(button("knowledgeSettings.addReviewer"));
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="knowledge-reviewer-section"]')).toHaveLength(2);
    expect(patchMock).toHaveBeenCalledTimes(1);
  });
  it("clears the message on removal and restores it after saving the removed reviewer", async () => {
    await saveFirstChange();
    await click(button("knowledgeSettings.removeReviewer"));
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).toBeNull();
    expect(element<HTMLButtonElement>("knowledge-settings-save").disabled).toBe(false);
    expect(patchMock).toHaveBeenCalledTimes(1);
    patchMock.mockResolvedValueOnce({ ...savedView, sectionReviewers: { value: [], source: "ui" } });
    await click(element("knowledge-settings-save"));
    await settle();
    expect(patchMock).toHaveBeenCalledTimes(2);
    expect(patchMock).toHaveBeenNthCalledWith(2, "company-1", { sectionReviewers: [] });
    expect(element("knowledge-settings-saved")?.textContent).toBe("Settings saved");
  });
  it("clears the saved message when a reviewer field changes", async () => {
    await saveFirstChange();
    await change(element("knowledge-reviewer-section"), "articles");
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).toBeNull();
    expect(patchMock).toHaveBeenCalledTimes(1);
  });
});
