// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
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

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.resetAllMocks(); });

it("blocks edits and duplicate saves until the pending PATCH completes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); client.clear(); container.remove(); };
  fetchMock.mockResolvedValue(view);
  let resolvePatch: (value: KnowledgeSettingsView) => void = () => {};
  patchMock.mockReturnValue(new Promise<KnowledgeSettingsView>((resolve) => { resolvePatch = resolve; }));
  await act(async () => { root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>); });
  for (let i = 0; i < 6; i++) await act(settle);

  const items = container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-items"]')!;
  const bytes = container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-bytes"]')!;
  const save = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setValue.call(items, "7000"); items.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(save.disabled).toBe(false);
  await act(async () => { save.click(); });
  for (let i = 0; i < 4; i++) await act(settle);
  expect(patchMock).toHaveBeenCalledTimes(1);
  expect(patchMock).toHaveBeenCalledWith("company-1", { maxItems: "7000" });
  expect(save.disabled).toBe(true);
  expect(bytes.matches(":disabled")).toBe(true);
  for (const control of container.querySelectorAll("input, select, button")) {
    expect(control.matches(":disabled")).toBe(true);
  }
  await act(async () => { bytes.click(); save.click(); });
  expect(patchMock).toHaveBeenCalledTimes(1);
  expect(bytes.value).toBe("262144");
  await act(async () => { resolvePatch({ ...view, maxItems: { value: 7000, source: "ui" } }); });
  for (let i = 0; i < 4; i++) await act(settle);
  expect(bytes.matches(":disabled")).toBe(false);
  expect(items.value).toBe("7000");
  expect(bytes.value).toBe("262144");
  expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
});
