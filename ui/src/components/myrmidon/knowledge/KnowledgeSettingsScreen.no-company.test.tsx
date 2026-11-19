// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";
import type { KnowledgeSettingsView } from "@myrmidon/shared";

const fetchMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const selectedCompanyId = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("./knowledgeSettingsApi", () => ({
  fetchKnowledgeSettings: (...args: unknown[]) => fetchMock(...args),
  patchKnowledgeSettings: (...args: unknown[]) => patchMock(...args),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: selectedCompanyId.value }),
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      return Object.entries(options).reduce(
        (result, [name, value]) => result.replace(`{{${name}}}`, String(value)),
        key,
      );
    },
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

const view = (maxItems: number): KnowledgeSettingsView => ({
  maxItems: { value: maxItems, source: "ui" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
});

describe("KnowledgeSettingsScreen without a selected company", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    selectedCompanyId.value = null;
    fetchMock.mockReset();
    patchMock.mockReset();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderScreen() {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <KnowledgeSettingsScreen />
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  async function selectCompany(companyId: string | null) {
    await act(async () => {
      selectedCompanyId.value = companyId;
      root!.render(
        <QueryClientProvider client={queryClient}>
          <KnowledgeSettingsScreen />
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  it("does not read or write and asks for a company on cold mount", async () => {
    await renderScreen();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(patchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="knowledge-settings-no-company"]')?.textContent).toBe(
      "knowledgeSettings.noCompany",
    );
    expect(container.querySelector('[data-testid="knowledge-settings-save"]')).toBeNull();
  });

  it("reads the selected company and renders its values", async () => {
    fetchMock.mockResolvedValue(view(100));
    await renderScreen();
    await selectCompany("company-a");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("company-a");
    expect(container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-items"]')?.value).toBe("100");
  });

  it("clears the form on deselection and ignores a late response", async () => {
    let resolveA: (value: KnowledgeSettingsView) => void;
    const pendingA = new Promise<KnowledgeSettingsView>((resolve) => { resolveA = resolve; });
    fetchMock.mockReturnValueOnce(pendingA);

    await renderScreen();
    await selectCompany("company-a");
    expect(container.querySelector('[data-testid="knowledge-settings-loading"]')).not.toBeNull();

    await selectCompany(null);
    expect(container.querySelector('[data-testid="knowledge-settings-no-company"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="knowledge-settings"]')).toBeNull();

    await act(async () => resolveA(view(100)));
    await settle();
    expect(container.querySelector('[data-testid="knowledge-settings"]')).toBeNull();
    expect(container.querySelector('[data-testid="knowledge-settings-no-company"]')).not.toBeNull();
  });

  it("reads company B after switching from company A without showing A", async () => {
    fetchMock.mockImplementation((companyId: string) => Promise.resolve(view(companyId === "company-a" ? 100 : 200)));

    await renderScreen();
    await selectCompany("company-a");
    expect(container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-items"]')?.value).toBe("100");

    await selectCompany(null);
    expect(container.querySelector('[data-testid="knowledge-settings"]')).toBeNull();
    expect(container.querySelector('[data-testid="knowledge-max-items"]')).toBeNull();
    expect(container.querySelector('[data-testid="knowledge-settings-save"]')).toBeNull();
    expect(container.querySelector('[data-testid="knowledge-settings-no-company"]')?.textContent).toBe("knowledgeSettings.noCompany");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).not.toHaveBeenCalled();

    await selectCompany("company-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "company-b");
    expect(container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-items"]')?.value).toBe("200");
    expect(container.textContent).not.toContain("100");
  });
});
