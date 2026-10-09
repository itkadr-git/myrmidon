// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browsersApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  journal: vi.fn(),
  openScreen: vi.fn(),
  heartbeat: vi.fn(),
  done: vi.fn(),
  clearSiteData: vi.fn(),
}));

const bridgeApiMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("./browsersApi", () => ({ browsersApi: browsersApiMock, egressSummary: (e: Record<string, string>) => Object.entries(e).map(([k, v]) => `${k}: ${v}`).join(", "), formatDuration: () => "1m 0s" }));

vi.mock("../connectorPanelApi", () => ({
  bridgeApi: bridgeApiMock,
  bridgeSettingsQueryKey: ["myrmidon", "browser-bridge", "settings"],
}));

import { BrowserScreenPanelView, type ScreenPanelState } from "./BrowserScreenPanel";
import { BrowsersSettingsPageView } from "./BrowsersSettingsPage";
import type { BridgeSettings } from "../connectorPanelApi";
import type { BrowserConsoleStatus } from "@paperclipai/shared/myrmidon-browser-console";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_ID = "company-a";

function browser(overrides: Partial<BrowserConsoleStatus> = {}): BrowserConsoleStatus {
  return {
    id: "browser-a",
    displayName: "Live browser A",
    egress: { ru: "socks ru1" },
    sessionActive: false,
    usedBy: null,
    sessionStartedAt: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const fn of Object.values(browsersApiMock)) fn.mockReset();
  bridgeApiMock.getSettings.mockReset();
  bridgeApiMock.updateSettings.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

function withClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function state(overrides: Partial<ScreenPanelState> = {}): ScreenPanelState {
  return { active: false, autoCloseAt: null, warnAt: null, closedBy: null, error: null, remainingMs: 0, ...overrides };
}

describe("BrowserScreenPanelView", () => {
  it("renders nothing when no session is open", () => {
    render(<BrowserScreenPanelView browserId="browser-a" state={state()} warning={false} onActivity={() => {}} onDone={() => {}} donePending={false} />);
    expect(container.querySelector('[data-testid="myrmidon-browser-screen-browser-a"]')).toBeNull();
  });

  it("shows the countdown, the activity report and Done while the session is open", () => {
    render(
      <BrowserScreenPanelView
        browserId="browser-a"
        state={state({ active: true, autoCloseAt: Date.now() + 120_000, remainingMs: 120_000 })}
        warning={false}
        onActivity={() => {}}
        onDone={() => {}}
        donePending={false}
      />,
    );
    expect(container.querySelector('[data-testid="myrmidon-browser-screen-browser-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-browser-screen-done-browser-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-browser-screen-activity-browser-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-browser-screen-warning-browser-a"]')).toBeNull();
  });

  it("shows the auto-close warning inside the last minute", () => {
    render(
      <BrowserScreenPanelView
        browserId="browser-a"
        state={state({ active: true, autoCloseAt: Date.now() + 30_000, remainingMs: 30_000 })}
        warning={true}
        onActivity={() => {}}
        onDone={() => {}}
        donePending={false}
      />,
    );
    const warning = container.querySelector('[data-testid="myrmidon-browser-screen-warning-browser-a"]');
    expect(warning).not.toBeNull();
    expect(warning!.textContent).toContain("closes soon");
  });

  it("Done closes the panel and shows the closed note", () => {
    const onDone = vi.fn();
    render(
      <BrowserScreenPanelView
        browserId="browser-a"
        state={state({ active: true, autoCloseAt: Date.now() + 120_000, remainingMs: 120_000 })}
        warning={false}
        onActivity={() => {}}
        onDone={onDone}
        donePending={false}
      />,
    );
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-browser-screen-done-browser-a"]')!.click();
    });
    expect(onDone).toHaveBeenCalledTimes(1);

    render(
      <BrowserScreenPanelView browserId="browser-a" state={state({ closedBy: "done" })} warning={false} onActivity={() => {}} onDone={() => {}} donePending={false} />,
    );
    expect(container.querySelector('[data-testid="myrmidon-browser-screen-closed-browser-a"]')?.textContent).toContain("Bots resumed");
  });
});

describe("BrowsersSettingsPageView", () => {
  it("lists the registry with id, display name, egress and occupancy", async () => {
    render(
      withClient(
        <BrowsersSettingsPageView
          browsers={[
            browser(),
            browser({ id: "browser-b", displayName: "Live browser B", sessionActive: true, usedBy: "user-a", sessionStartedAt: new Date(0).toISOString() }),
          ]}
          journal={[]}
          companyId={COMPANY_ID}
          loading={false}
          error={null}
        />,
      ),
    );
    await flush();
    const card = container.querySelector('[data-testid="myrmidon-browser-browser-a"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Live browser A");
    expect(card!.textContent).toContain("browser-a");
    expect(card!.textContent).toContain("socks ru1");
    expect(container.querySelector('[data-testid="myrmidon-browser-in-use-browser-b"]')?.textContent).toContain("user-a");
    expect(container.querySelector('[data-testid="myrmidon-browsers-empty"]')).toBeNull();
  });

  it("shows the empty state when no browsers are configured", async () => {
    render(withClient(<BrowsersSettingsPageView browsers={[]} journal={[]} companyId={COMPANY_ID} loading={false} error={null} />));
    await flush();
    expect(container.querySelector('[data-testid="myrmidon-browsers-empty"]')).not.toBeNull();
  });

  it("renders the journal with who, when, duration and closed-by", async () => {
    render(
      withClient(
        <BrowsersSettingsPageView
          browsers={[browser()]}
          journal={[
            { browserId: "browser-a", userId: "user-a", startedAt: new Date(0).toISOString(), durationMs: 300_000, closedBy: "done" },
          ]}
          companyId={COMPANY_ID}
          loading={false}
          error={null}
        />,
      ),
    );
    await flush();
    const entry = container.querySelector('[data-testid="myrmidon-browsers-journal-entry"]');
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toContain("browser-a");
    expect(entry!.textContent).toContain("user-a");
    expect(entry!.textContent).toContain("closed by done");
  });

  it("the clear form refuses an empty domain client-side and shows server errors", async () => {
    browsersApiMock.clearSiteData.mockRejectedValueOnce(new Error("Close the screen session before clearing site data"));
    render(withClient(<BrowsersSettingsPageView browsers={[browser()]} journal={[]} companyId={COMPANY_ID} loading={false} error={null} />));
    await flush();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-browser-clear-button-browser-a"]');
    expect(button!.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>('[data-testid="myrmidon-browser-clear-domain-browser-a"]');
    expect(input).not.toBeNull();
    const domainInput = input!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(domainInput, "example.com");
      domainInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await flush();
    expect(button!.disabled).toBe(false);
    act(() => button!.click());
    await flush();
    expect(browsersApiMock.clearSiteData).toHaveBeenCalledWith("browser-a", COMPANY_ID, "example.com");
    await flush();
    expect(container.querySelector('[data-testid="myrmidon-browser-clear-error-browser-a"]')?.textContent).toContain("Close the screen session");
  });
});

describe("BrowsersSettingsPageView signing block", () => {
  function settings(enabled: boolean): BridgeSettings {
    return { domains: ["tender.example.test"], signing: { enabled, mode: "manual", types: ["tender.submit"], dailyLimit: 5 } };
  }

  function renderPage(signing: BridgeSettings | null, overrides: { signingLoading?: boolean; signingError?: string | null } = {}) {
    render(
      withClient(
        <BrowsersSettingsPageView
          browsers={[browser()]}
          journal={[]}
          companyId={COMPANY_ID}
          loading={false}
          error={null}
          signing={signing}
          signingLoading={overrides.signingLoading ?? false}
          signingError={overrides.signingError ?? null}
        />,
      ),
    );
    return flush();
  }

  it("shows the state and the re-enable button only while signing is off", async () => {
    await renderPage(settings(true));
    expect(container.querySelector('[data-testid="myrmidon-signing-state"]')?.textContent).toContain("Signing is on");
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable"]')).toBeNull();

    await renderPage(settings(false));
    expect(container.querySelector('[data-testid="myrmidon-signing-state"]')?.textContent).toContain("Signing is off");
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable"]')).not.toBeNull();
  });

  it("opens the confirmation and cancels it without a settings write", async () => {
    await renderPage(settings(false));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-signing-reenable"]')!.click());
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable-confirm"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable-cancel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable"]')).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-signing-reenable-cancel"]')!.click());
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable-confirm"]')).toBeNull();
    expect(bridgeApiMock.updateSettings).not.toHaveBeenCalled();
  });

  it("confirms the write with enabled true and keeps the stored signing fields", async () => {
    bridgeApiMock.updateSettings.mockResolvedValue(settings(true));
    await renderPage(settings(false));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-signing-reenable"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-signing-reenable-confirm"]')!.click());
    await flush();
    expect(bridgeApiMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(bridgeApiMock.updateSettings).toHaveBeenCalledWith({
      signing: { enabled: true, mode: "manual", types: ["tender.submit"], dailyLimit: 5 },
    });
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable-confirm"]')).toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable-error"]')).toBeNull();
  });

  it("reports a failed write without re-enabling signing", async () => {
    bridgeApiMock.updateSettings.mockRejectedValueOnce(new Error("Signing is locked by the operator"));
    await renderPage(settings(false));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-signing-reenable"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="myrmidon-signing-reenable-confirm"]')!.click());
    await flush();
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable-error"]')?.textContent).toContain("Signing is locked by the operator");
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable"]')).not.toBeNull();
  });

  it("keeps the page usable and reports the read failure", async () => {
    await renderPage(null, { signingError: "browser bridge is not configured" });
    expect(container.querySelector('[data-testid="myrmidon-signing-read-error"]')?.textContent).toContain("browser bridge is not configured");
    expect(container.querySelector('[data-testid="myrmidon-signing-reenable"]')).toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-browser-browser-a"]')).not.toBeNull();
  });
});
