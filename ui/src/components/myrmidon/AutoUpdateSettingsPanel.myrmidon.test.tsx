// @vitest-environment jsdom
//
// myrmidon(1.7-AUTO-UPDATE-B): the Product updates section of Instance →
// General — the maintenance window, the update mode, the fleet canary and the
// approved releases, each with the source of the value in force.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { AutoUpdateSettingsPanel } from "./AutoUpdateSettingsPanel";
import { autoUpdateApi, type AutoUpdateView } from "./autoUpdateApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STORED = {
  mode: "auto_release" as const,
  window: { days: [1], fromMinute: 9 * 60, toMinute: 12 * 60 },
  canary: { enabled: true, sharePercent: 25, minBots: 1, maxBots: 3, healthSettleSec: 300 },
  approvals: [
    {
      tag: "myr-v1.7.0",
      digest: `sha256:${"b".repeat(64)}`,
      version: "1.7.0",
      approvedBy: { actorType: "board", actorId: "user-a" },
      approvedAt: "2026-10-07T08:00:00.000Z",
      jobId: null,
    },
  ],
};

function view(overrides: Partial<AutoUpdateView> = {}): AutoUpdateView {
  return {
    stored: STORED,
    settings: STORED,
    sources: { mode: "ui", window: "ui", canary: "ui" },
    overridden: [],
    window: { open: false, opensAt: "2026-10-08T09:00:00.000Z", closesAt: null, reason: "outside the maintenance window" },
    start: { allowed: true, reason: "the window is open", candidate: STORED.approvals[0] },
    defaults: STORED,
    ...overrides,
  };
}

function renderPanel(value: AutoUpdateView) {
  vi.spyOn(autoUpdateApi, "get").mockResolvedValue(value);
  vi.spyOn(autoUpdateApi, "patch").mockResolvedValue(value);
  vi.spyOn(autoUpdateApi, "approve").mockResolvedValue(value);
  vi.spyOn(autoUpdateApi, "withdraw").mockResolvedValue(value);
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AutoUpdateSettingsPanel />
    </QueryClientProvider>,
  );
  return container;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function byTestId(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${id}']`);
}

/** React-controlled inputs need the native value setter for a synthetic change. */
function type(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(container: HTMLElement, id: string) {
  act(() => byTestId(container, id)!.click());
}

describe("AutoUpdateSettingsPanel", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await i18n.changeLanguage("en");
  });

  it("shows the window, what would start now, and where each value came from", async () => {
    const container = renderPanel(view());
    await settle();

    const windowState = byTestId(container, "auto-update-window-state")?.textContent ?? "";
    expect(windowState).toContain("Window now: shut");
    expect(windowState).toContain("2026-10-08T09:00:00.000Z");
    expect(byTestId(container, "auto-update-start-state")?.textContent).toContain("myr-v1.7.0");
    expect(container.textContent).toContain("set here");
    // Nothing changed yet, so Save is off.
    expect((byTestId(container, "auto-update-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says when the environment forces a value", async () => {
    const container = renderPanel(view({ overridden: ["window"] }));
    await settle();

    expect(byTestId(container, "auto-update-env-note")?.textContent).toContain("window");
  });

  it("sends the window, the mode and the canary when something changed", async () => {
    const container = renderPanel(view());
    await settle();

    act(() => {
      const select = byTestId(container, "auto-update-mode-select") as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "manual");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect((byTestId(container, "auto-update-save") as HTMLButtonElement).disabled).toBe(false);

    click(container, "auto-update-save");
    await settle();

    expect(autoUpdateApi.patch).toHaveBeenCalledWith({
      mode: "manual",
      window: { days: [1], fromMinute: 540, toMinute: 720 },
      canary: { enabled: true, sharePercent: 25, minBots: 1, maxBots: 3, healthSettleSec: 300 },
    });
  });

  it("refuses a window edge that was cleared instead of a time of day", async () => {
    const container = renderPanel(view());
    await settle();

    // The time input cannot hold a non-time, so the reachable mistake is an
    // empty field; the panel refuses to send it and says why.
    type(container, "#auto-update-from", "");
    await settle();
    click(container, "auto-update-save");
    await settle();

    expect(autoUpdateApi.patch).not.toHaveBeenCalled();
    expect(byTestId(container, "auto-update-error")?.textContent).toContain("From must look like HH:MM");
  });

  it("approves a release by tag and digest", async () => {
    const container = renderPanel(view());
    await settle();

    type(container, "#auto-update-approve-tag", " myr-v1.6.9 ");
    type(container, "#auto-update-approve-digest", `sha256:${"c".repeat(64)}`);
    type(container, "#auto-update-approve-version", "1.6.9");
    await settle();
    click(container, "auto-update-approve");
    await settle();

    expect(autoUpdateApi.approve).toHaveBeenCalledWith({
      tag: "myr-v1.6.9",
      digest: `sha256:${"c".repeat(64)}`,
      version: "1.6.9",
    });
  });

  it("shows the approved releases and can withdraw one", async () => {
    const container = renderPanel(view());
    await settle();

    click(container, "auto-update-withdraw-myr-v1.7.0");
    await settle();

    expect(autoUpdateApi.withdraw).toHaveBeenCalledWith("myr-v1.7.0");
  });
});