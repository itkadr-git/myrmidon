// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";
import type { KnowledgeSettingsView } from "@myrmidon/shared";

const fetchMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());

vi.mock("./knowledgeSettingsApi", () => ({
  fetchKnowledgeSettings: (...args: unknown[]) => fetchMock(...args),
  patchKnowledgeSettings: (...args: unknown[]) => patchMock(...args),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// The screen imports useTranslation from "@/i18n"; the real i18n instance
// needs a full provider tree, so we stub it to return key lookups.
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options) {
        let result = key;
        for (const [k, v] of Object.entries(options)) {
          result = result.replace(`{{${k}}}`, String(v));
        }
        return result;
      }
      return key;
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const defaultView: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};

describe("KnowledgeSettingsScreen", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    fetchMock.mockReset();
    patchMock.mockReset();
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
      root = null;
    }
    queryClient?.clear();
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
    // let the query resolve
    for (let i = 0; i < 6; i++) await settle();
  }

  it("shows loading state while fetching", async () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    await renderScreen();
    expect(container.querySelector('[data-testid="knowledge-settings-loading"]')).not.toBeNull();
  });

  it("renders effective values and source badges after load", async () => {
    fetchMock.mockResolvedValue(defaultView);
    await renderScreen();

    expect(container.querySelector('[data-testid="knowledge-settings"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="knowledge-max-items"]')).not.toBeNull();

    // source badges for default source
    const badges = container.querySelectorAll('[data-testid="knowledge-source-badge"]');
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.getAttribute("data-source")).toBe("default");
    }
  });

  it("shows validation error when maxItems is out of bounds", async () => {
    fetchMock.mockResolvedValue(defaultView);
    await renderScreen();

    const input = container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-items"]')!;
    expect(input).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "999999");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (let i = 0; i < 4; i++) await settle();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("knowledgeSettings.invalidNumber");
  });

  it("disables save when no changes", async () => {
    fetchMock.mockResolvedValue(defaultView);
    await renderScreen();

    const saveBtn = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!;
    expect(saveBtn.disabled).toBe(true);
  });

  it("enables save and calls patch API after editing a field", async () => {
    fetchMock.mockResolvedValue(defaultView);
    const updated: KnowledgeSettingsView = {
      ...defaultView,
      maxItems: { value: 7000, source: "ui" },
    };
    patchMock.mockResolvedValue(updated);
    await renderScreen();

    const input = container.querySelector<HTMLInputElement>('[data-testid="knowledge-max-items"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "7000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (let i = 0; i < 4; i++) await settle();

    const saveBtn = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!;
    expect(saveBtn.disabled).toBe(false);

    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 4; i++) await settle();

    expect(patchMock).toHaveBeenCalledWith("company-1", { maxItems: "7000" });
    expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
  });

  it("shows error state on fetch failure", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    await renderScreen();

    expect(container.querySelector('[data-testid="knowledge-settings-error"]')).not.toBeNull();
  });
});
