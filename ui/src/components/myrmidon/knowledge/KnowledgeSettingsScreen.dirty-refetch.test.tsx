// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeSettingsView } from "@myrmidon/shared";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";

const { fetchMock, patchMock, company } = vi.hoisted(() => ({
  fetchMock: vi.fn(), patchMock: vi.fn(), company: { id: "company-1" },
}));
vi.mock("./knowledgeSettingsApi", () => ({
  fetchKnowledgeSettings: (...args: unknown[]) => fetchMock(...args),
  patchKnowledgeSettings: (...args: unknown[]) => patchMock(...args),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: company.id }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const initial: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};
const refreshed: KnowledgeSettingsView = {
  ...initial,
  maxItems: { value: 6000, source: "ui" },
  maxRevisionBytes: { value: 524288, source: "ui" },
};
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("KnowledgeSettingsScreen dirty refetch", () => {
  let container: HTMLDivElement;
  let client: QueryClient;
  let root: ReturnType<typeof createRoot>;
  const input = (id: string) => container.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
  const render = () => flushSync(() => root.render(
    <QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>,
  ));
  const wait = async () => { for (let i = 0; i < 6; i++) await settle(); };
  const edit = (value: string) => flushSync(() => {
    const element = input("knowledge-max-items");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

  beforeEach(() => {
    company.id = "company-1";
    fetchMock.mockReset();
    patchMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  });

  it("preserves edits while refreshing untouched fields and saves only the edit", async () => {
    fetchMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    patchMock.mockResolvedValue({ ...refreshed, maxItems: { value: 7000, source: "ui" } });
    render();
    await wait();
    edit("7000");
    expect(input("knowledge-max-items").value).toBe("7000");
    await client.refetchQueries({ queryKey: ["knowledge-settings", "company-1"] });
    await wait();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(input("knowledge-max-items").value).toBe("7000");
    expect(input("knowledge-max-bytes").value).toBe("524288");
    const save = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!;
    expect(save.disabled).toBe(false);
    flushSync(() => save.click());
    await wait();
    expect(patchMock).toHaveBeenCalledExactlyOnceWith("company-1", { maxItems: "7000" });
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
  });

  it("does not carry a draft to a different company", async () => {
    fetchMock.mockImplementation(async (id: string) => id === "company-1" ? initial : refreshed);
    patchMock.mockResolvedValue({ ...refreshed, maxItems: { value: 8000, source: "ui" } });
    render();
    await wait();
    edit("7000");
    company.id = "company-2";
    render();
    await wait();
    expect(fetchMock).toHaveBeenCalledWith("company-2");
    expect(input("knowledge-max-items").value).toBe("6000");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!.disabled).toBe(true);
    edit("8000");
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!.click());
    await wait();
    expect(patchMock).toHaveBeenCalledExactlyOnceWith("company-2", { maxItems: "8000" });
  });
});
