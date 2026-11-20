// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSettingsView } from "@myrmidon/shared";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";

const fetchMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock("./knowledgeSettingsApi", () => ({
  fetchKnowledgeSettings: (...args: unknown[]) => fetchMock(...args),
  patchKnowledgeSettings: (...args: unknown[]) => patchMock(...args),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Match the existing screen tests' React environment.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function flush() {
  for (let i = 0; i < 6; i++) await settle();
}

const initial: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};

describe("KnowledgeSettingsScreen save retry", () => {
  const container = document.createElement("div");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const root = createRoot(container);

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("preserves the draft after a failed patch and retries the same minimal patch", async () => {
    document.body.appendChild(container);
    fetchMock.mockResolvedValue(initial);
    patchMock.mockRejectedValueOnce(new Error("network"));
    patchMock.mockResolvedValueOnce({ ...initial, maxItems: { value: 7000, source: "ui" } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>);
    });
    await act(async () => { await flush(); });

    const input = container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-items"]')!;
    const neighbor = container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-bytes"]')!;
    const save = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!;
    expect(input.value).toBe("5000");
    expect(neighbor.value).toBe("262144");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "7000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); await flush(); });

    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenNthCalledWith(1, "company-1", { maxItems: "7000" });
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("knowledgeSettings.saveError");
    expect(input.value).toBe("7000");
    expect(neighbor.value).toBe("262144");
    expect(save.disabled).toBe(false);

    await act(async () => { save.click(); await flush(); });
    expect(patchMock).toHaveBeenCalledTimes(2);
    expect(patchMock).toHaveBeenNthCalledWith(2, "company-1", { maxItems: "7000" });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
    expect(input.value).toBe("7000");
    expect(neighbor.value).toBe("262144");
    expect(save.disabled).toBe(true);
  });
});
