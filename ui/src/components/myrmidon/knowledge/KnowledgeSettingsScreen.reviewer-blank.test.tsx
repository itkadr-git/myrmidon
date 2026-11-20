// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
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
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const view: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

describe("KnowledgeSettingsScreen reviewer drafts", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    fetchMock.mockReset();
    patchMock.mockReset();
  });
  afterEach(() => { flushSync(() => root?.unmount()); client.clear(); container.remove(); });
  async function render(initial: KnowledgeSettingsView) {
    fetchMock.mockResolvedValue(initial);
    root = createRoot(container);
    flushSync(() => root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>));
    await settle();
  }
  function input(testId: string, value: string) {
    const element = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function clickText(text: string) {
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text)!;
    expect(button).toBeDefined();
    flushSync(() => button.click());
  }
  function save() { return container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!; }

  it.each(["", "   "])("preserves reviewer ID and prevents saving an incomplete section %j", async (section) => {
    await render(view);
    clickText("knowledgeSettings.addReviewer");
    input("knowledge-reviewer-id", "reviewer-123");
    if (section) input("knowledge-reviewer-section", section);
    input("knowledge-max-items", "7000");
    expect(container.querySelector<HTMLInputElement>('[data-testid="knowledge-reviewer-id"]')!.value).toBe("reviewer-123");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("knowledgeSettings.invalidReviewers");
    expect(save().disabled).toBe(true);
    flushSync(() => save().click());
    expect(patchMock).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('[data-testid="knowledge-reviewer-id"]')!.value).toBe("reviewer-123");
    input("knowledge-reviewer-section", "engineering");
    patchMock.mockResolvedValue({ ...view, maxItems: { value: 7000, source: "ui" }, sectionReviewers: { value: [{ section: "engineering", reviewerKind: "user", reviewerId: "reviewer-123" }], source: "ui" } });
    expect(save().disabled).toBe(false);
    flushSync(() => save().click());
    await settle();
    expect(patchMock).toHaveBeenCalledWith("company-1", { maxItems: "7000", sectionReviewers: [{ section: "engineering", reviewerKind: "user", reviewerId: "reviewer-123" }] });
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
  });

  it("ignores a completely blank new row while saving another setting", async () => {
    await render(view);
    clickText("knowledgeSettings.addReviewer");
    input("knowledge-max-items", "7000");
    patchMock.mockResolvedValue({ ...view, maxItems: { value: 7000, source: "ui" } });
    expect(save().disabled).toBe(false);
    flushSync(() => save().click());
    await settle();
    expect(patchMock).toHaveBeenCalledWith("company-1", { maxItems: "7000" });
    expect(container.querySelector('[data-testid="knowledge-reviewer-id"]')).toBeNull();
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
  });

  it("sends an explicit empty reviewer list when removing an existing reviewer", async () => {
    await render({ ...view, sectionReviewers: { value: [{ section: "engineering", reviewerKind: "user", reviewerId: "reviewer-123" }], source: "ui" } });
    clickText("knowledgeSettings.removeReviewer");
    patchMock.mockResolvedValue(view);
    expect(save().disabled).toBe(false);
    flushSync(() => save().click());
    await settle();
    expect(patchMock).toHaveBeenCalledWith("company-1", { sectionReviewers: [] });
    expect(container.querySelector('[data-testid="knowledge-reviewer-id"]')).toBeNull();
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
  });
});
