// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { knowledgeScheduleOk, type KnowledgeSettingsView } from "@myrmidon/shared";
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
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function flush(callback: () => void) {
  await act(async () => {
    flushSync(callback);
    for (let i = 0; i < 6; i++) await settle();
  });
}

const initial: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};

describe("KnowledgeSettingsScreen schedule boundary", () => {
  const container = document.createElement("div");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    queryClient.clear();
    container.remove();
    vi.resetAllMocks();
  });

  it("rejects invalid input, preserves it, and saves a corrected schedule exactly", async () => {
    const invalid = "0 12 * *";
    const valid = "15 12 * * *";
    expect(knowledgeScheduleOk(invalid)).toBe(false);
    expect(knowledgeScheduleOk(valid)).toBe(true);
    fetchMock.mockResolvedValue(initial);
    patchMock.mockResolvedValue({ ...initial, schedule: { value: valid, source: "ui" } });
    document.body.appendChild(container);
    root = createRoot(container);
    await flush(() => root?.render(<QueryClientProvider client={queryClient}><KnowledgeSettingsScreen /></QueryClientProvider>));

    const input = container.querySelector<HTMLInputElement>('[data-testid="knowledge-schedule"]');
    const save = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]');
    expect(input).not.toBeNull();
    expect(save).not.toBeNull();
    if (!input || !save) throw new Error("Schedule controls not rendered");
    const edit = async (value: string) => flush(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("Input value setter unavailable");
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await edit(invalid);
    expect(input.value).toBe(invalid);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("knowledgeSettings.invalidSchedule");
    expect(save.disabled).toBe(true);
    await flush(() => save.click());
    expect(patchMock).not.toHaveBeenCalled();

    await edit(initial.schedule.value);
    expect(input.value).toBe(initial.schedule.value);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(save.disabled).toBe(true);
    await flush(() => save.click());
    expect(patchMock).not.toHaveBeenCalled();

    await edit(valid);
    expect(input.value).toBe(valid);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(save.disabled).toBe(false);
    await flush(() => save.click());
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledWith("company-1", { schedule: valid });
    expect(input.value).toBe(valid);
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
    expect(save.disabled).toBe(true);
  });
});
