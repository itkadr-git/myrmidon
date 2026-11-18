// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const view: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Knowledge settings confidence boundary", () => {
  let container: HTMLDivElement;
  let client: QueryClient;
  let root: ReturnType<typeof createRoot>;
  beforeEach(async () => {
    fetchMock.mockReset().mockResolvedValue(view);
    patchMock.mockReset().mockImplementation(async (_company, patch) => ({
      ...view,
      autoAcceptEnabled: { value: patch.autoAcceptEnabled ?? view.autoAcceptEnabled.value, source: "ui" },
      autoAcceptMinConfidence: { value: patch.autoAcceptMinConfidence ?? view.autoAcceptMinConfidence.value, source: "ui" },
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    root = createRoot(container);
    await act(() => root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>));
    await settle();
  });
  afterEach(async () => {
    await act(() => root.unmount());
    client.clear();
    container.remove();
  });
  function input() { return container.querySelector<HTMLInputElement>('[data-testid="knowledge-confidence"]')!; }
  function save() { return container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!; }
  async function change(value: string) {
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  }
  async function click(element: HTMLElement) {
    await act(() => element.click());
    await settle();
  }

  it.each(["0", "0.0000", "1", "1.0000"])("saves valid boundary %s without unrelated fields", async (value) => {
    await change(value);
    expect(input().value).toBe(value);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(save().disabled).toBe(false);
    await click(save());
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledWith("company-1", { autoAcceptMinConfidence: value });
    expect(input().value).toBe(value);
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
  });

  it.each(["-0.0001", "1.0001", "", "abc", "0.00001"])("blocks invalid %s and saves the corrected input", async (invalid) => {
    await change(invalid);
    expect(input().value).toBe(invalid);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("knowledgeSettings.invalidConfidence");
    expect(save().disabled).toBe(true);
    await click(save());
    expect(patchMock).not.toHaveBeenCalled();
    await change("0.75");
    expect(input().value).toBe("0.75");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(save().disabled).toBe(false);
    await click(save());
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledWith("company-1", { autoAcceptMinConfidence: "0.75" });
    expect(input().value).toBe("0.75");
  });

  it("toggles auto-accept without replacing the confidence or sending untouched fields", async () => {
    const toggle = container.querySelector<HTMLInputElement>('[data-testid="knowledge-auto-accept"]')!;
    await click(toggle);
    expect(toggle.checked).toBe(true);
    expect(input().value).toBe("0.9");
    await click(save());
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledWith("company-1", { autoAcceptEnabled: true });
    expect(input().value).toBe("0.9");
  });

  it("keeps an edited confidence when auto-accept is toggled", async () => {
    await change("0.37");
    const toggle = container.querySelector<HTMLInputElement>('[data-testid="knowledge-auto-accept"]')!;
    await click(toggle);
    expect(toggle.checked).toBe(true);
    expect(input().value).toBe("0.37");
    await click(save());
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledWith("company-1", { autoAcceptEnabled: true, autoAcceptMinConfidence: "0.37" });
    expect(input().value).toBe("0.37");
  });
});
