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
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const view: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};
const marker = "synthetic-private-error-12345";

// React Query schedules notifications on a timer.
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

describe("KnowledgeSettingsScreen initial load retry", () => {
  let container: HTMLDivElement;
  let client: QueryClient;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    fetchMock.mockReset();
    patchMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });

  async function renderFailure() {
    fetchMock.mockRejectedValueOnce(new Error(marker));
    await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>));
    await settle();
    expect(container.querySelector('[data-testid="knowledge-settings-error"]')?.textContent).toBe("knowledgeSettings.loadError");
    expect(container.textContent).not.toContain(marker);
    expect(fetchMock.mock.calls).toEqual([["company-1"]]);
  }
  function retryButton() {
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "common.retry");
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
    return button!;
  }

  it("retries once while pending and displays the returned settings", async () => {
    await renderFailure();
    let resolve!: (value: KnowledgeSettingsView) => void;
    fetchMock.mockReturnValueOnce(new Promise<KnowledgeSettingsView>((done) => { resolve = done; }));
    const button = retryButton();
    await act(async () => { button.click(); button.click(); });
    await settle();
    expect(fetchMock.mock.calls).toEqual([["company-1"], ["company-1"]]);
    const pendingButton = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "common.retry");
    expect(!pendingButton || pendingButton.disabled).toBe(true);
    await act(async () => resolve(view));
    await settle();
    expect(container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-items"]')?.value).toBe("5000");
    expect(container.querySelector('[data-testid="knowledge-settings-error"]')).toBeNull();
    expect(container.textContent).not.toContain(marker);
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("allows another retry after a repeated failure without exposing the error", async () => {
    await renderFailure();
    fetchMock.mockRejectedValueOnce(new Error(marker));
    await act(async () => retryButton().click());
    await settle();
    expect(fetchMock.mock.calls).toEqual([["company-1"], ["company-1"]]);
    expect(container.querySelector('[data-testid="knowledge-settings-error"]')?.textContent).toBe("knowledgeSettings.loadError");
    expect(container.textContent).not.toContain(marker);
    retryButton();
    expect(patchMock).not.toHaveBeenCalled();
  });
});
