// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmClaimSettingsView } from "../../../../components/myrmidon/swarmClaimSettingsApi";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";
import { swarmClaimSettingsApi } from "../../../../components/myrmidon/swarmClaimSettingsApi";
import { Ui2SwarmClaimBlock } from "./Ui2SwarmClaimBlock";

vi.mock("../../../../components/myrmidon/swarmClaimSettingsApi", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../components/myrmidon/swarmClaimSettingsApi")
  >("../../../../components/myrmidon/swarmClaimSettingsApi");
  return {
    ...actual,
    swarmClaimSettingsApi: {
      get: vi.fn(),
      update: vi.fn(),
    },
  };
});

function createDefaultView(overrides: Partial<SwarmClaimSettingsView> = {}): SwarmClaimSettingsView {
  return {
    settings: {
      enabled: true,
      leaseTtlSec: 600,
      maxActiveTasks: 4,
      p0Preemption: false,
      sweepIntervalSec: 30,
      ...overrides.settings,
    },
    sources: {
      enabled: "settings",
      leaseTtlSec: "default",
      maxActiveTasks: "default",
      p0Preemption: "default",
      sweepIntervalSec: "default",
      ...overrides.sources,
    },
    counters: {
      queuedUnassigned: 12,
      claimedLastHour: 7,
      cancelledLastHour: 1,
      ...overrides.counters,
    },
    recentAudit: overrides.recentAudit ?? [],
    cooldown: overrides.cooldown ?? { remainingSec: 0, active: false },
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

describe("Ui2SwarmClaimBlock", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderBlock(locale: "ru" | "en" = "ru") {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale={locale}>
            <Ui2SwarmClaimBlock />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders values, sources, and queue status from GET", async () => {
    const view = createDefaultView({
      sources: {
        enabled: "settings",
        leaseTtlSec: "default",
        maxActiveTasks: "env",
        p0Preemption: "default",
        sweepIntervalSec: "default",
      },
    });
    vi.mocked(swarmClaimSettingsApi.get).mockResolvedValueOnce(view);

    await renderBlock("ru");

    const switchInput = container.querySelector<HTMLInputElement>("#ui2-swarm-claim-enabled");
    const ttlInput = container.querySelector<HTMLInputElement>("#ui2-swarm-claim-lease-ttl");
    const limitInput = container.querySelector<HTMLInputElement>("#ui2-swarm-claim-max-tasks");
    const statusLine = container.querySelector<HTMLElement>("[data-testid='ui2-swarm-claim-status']");

    expect(switchInput).not.toBeNull();
    expect(switchInput?.checked).toBe(true);

    expect(ttlInput).not.toBeNull();
    expect(ttlInput?.value).toBe("600");

    expect(limitInput).not.toBeNull();
    expect(limitInput?.value).toBe("4");
    expect(limitInput?.disabled).toBe(true);

    const enabledSource = container.querySelector("[data-testid='ui2-swarm-claim-enabled-source']");
    const ttlSource = container.querySelector("[data-testid='ui2-swarm-claim-lease-ttl-source']");
    const limitSource = container.querySelector("[data-testid='ui2-swarm-claim-max-tasks-source']");

    expect(enabledSource?.textContent).toBe("сохранено");
    expect(ttlSource?.textContent).toBe("по умолчанию");
    expect(limitSource?.textContent).toBe("задано окружением");

    expect(statusLine).not.toBeNull();
    expect(statusLine?.textContent).toContain("12");
    expect(statusLine?.textContent).toContain("7");
    expect(statusLine?.textContent).toContain("1");
  });

  it("sends PATCH on toggling the switch and updates the view", async () => {
    const initialView = createDefaultView({ settings: { enabled: true, leaseTtlSec: 600, maxActiveTasks: 4, p0Preemption: false, sweepIntervalSec: 30 } });
    const updatedView = createDefaultView({ settings: { enabled: false, leaseTtlSec: 600, maxActiveTasks: 4, p0Preemption: false, sweepIntervalSec: 30 } });

    vi.mocked(swarmClaimSettingsApi.get).mockResolvedValueOnce(initialView);
    vi.mocked(swarmClaimSettingsApi.update).mockResolvedValueOnce(updatedView);

    await renderBlock("ru");

    const switchInput = container.querySelector<HTMLInputElement>("#ui2-swarm-claim-enabled");
    expect(switchInput?.checked).toBe(true);

    switchInput?.click();
    await flushReact();

    expect(swarmClaimSettingsApi.update).toHaveBeenCalledWith({ enabled: false });
    expect(switchInput?.checked).toBe(false);
  });

  it("sends PATCH on changing lease TTL and updates the view", async () => {
    const initialView = createDefaultView({ settings: { enabled: true, leaseTtlSec: 600, maxActiveTasks: 4, p0Preemption: false, sweepIntervalSec: 30 } });
    const updatedView = createDefaultView({ settings: { enabled: true, leaseTtlSec: 1800, maxActiveTasks: 4, p0Preemption: false, sweepIntervalSec: 30 } });

    vi.mocked(swarmClaimSettingsApi.get).mockResolvedValueOnce(initialView);
    vi.mocked(swarmClaimSettingsApi.update).mockResolvedValueOnce(updatedView);

    await renderBlock("ru");

    const ttlInput = container.querySelector<HTMLInputElement>("#ui2-swarm-claim-lease-ttl");
    expect(ttlInput?.value).toBe("600");

    setNativeValue(ttlInput!, "1800");
    await flushReact();

    expect(swarmClaimSettingsApi.update).toHaveBeenCalledWith({ leaseTtlSec: 1800 });
    expect(ttlInput?.value).toBe("1800");
  });

  it("sends PATCH on changing per-agent task limit and clearing it", async () => {
    const initialView = createDefaultView({ settings: { enabled: true, leaseTtlSec: 600, maxActiveTasks: 4, p0Preemption: false, sweepIntervalSec: 30 } });
    const updatedWithLimit = createDefaultView({ settings: { enabled: true, leaseTtlSec: 600, maxActiveTasks: 10, p0Preemption: false, sweepIntervalSec: 30 } });
    const updatedCleared = createDefaultView({ settings: { enabled: true, leaseTtlSec: 600, maxActiveTasks: null, p0Preemption: false, sweepIntervalSec: 30 } });

    vi.mocked(swarmClaimSettingsApi.get).mockResolvedValueOnce(initialView);
    vi.mocked(swarmClaimSettingsApi.update).mockResolvedValueOnce(updatedWithLimit);

    await renderBlock("ru");

    const limitInput = container.querySelector<HTMLInputElement>("#ui2-swarm-claim-max-tasks");
    expect(limitInput?.value).toBe("4");

    setNativeValue(limitInput!, "10");
    await flushReact();

    expect(swarmClaimSettingsApi.update).toHaveBeenCalledWith({ maxActiveTasks: 10 });
    expect(limitInput?.value).toBe("10");

    vi.mocked(swarmClaimSettingsApi.update).mockResolvedValueOnce(updatedCleared);
    setNativeValue(limitInput!, "");
    await flushReact();

    expect(swarmClaimSettingsApi.update).toHaveBeenCalledWith({ maxActiveTasks: null });
    expect(limitInput?.value).toBe("");
  });

  it("disables fields pinned by environment and labels them 'задано окружением'", async () => {
    const envPinnedView = createDefaultView({
      sources: {
        enabled: "env",
        leaseTtlSec: "env",
        maxActiveTasks: "env",
        p0Preemption: "default",
        sweepIntervalSec: "default",
      },
    });

    vi.mocked(swarmClaimSettingsApi.get).mockResolvedValueOnce(envPinnedView);

    await renderBlock("ru");

    const switchInput = container.querySelector<HTMLInputElement>("#ui2-swarm-claim-enabled");
    const ttlInput = container.querySelector<HTMLInputElement>("#ui2-swarm-claim-lease-ttl");
    const limitInput = container.querySelector<HTMLInputElement>("#ui2-swarm-claim-max-tasks");

    expect(switchInput?.disabled).toBe(true);
    expect(ttlInput?.disabled).toBe(true);
    expect(limitInput?.disabled).toBe(true);

    const enabledSource = container.querySelector("[data-testid='ui2-swarm-claim-enabled-source']");
    const ttlSource = container.querySelector("[data-testid='ui2-swarm-claim-lease-ttl-source']");
    const limitSource = container.querySelector("[data-testid='ui2-swarm-claim-max-tasks-source']");

    expect(enabledSource?.textContent).toBe("задано окружением");
    expect(ttlSource?.textContent).toBe("задано окружением");
    expect(limitSource?.textContent).toBe("задано окружением");
  });

  it("renders Ui2ErrorState on API error without blank screen and allows retry", async () => {
    vi.mocked(swarmClaimSettingsApi.get).mockRejectedValueOnce(new Error("Network failed"));

    await renderBlock("ru");

    const errorState = container.querySelector(".ui2-error-state");
    expect(errorState).not.toBeNull();
    expect(container.textContent).toContain("Network failed");

    // Click retry
    const retryButton = errorState?.querySelector("button");
    expect(retryButton).not.toBeNull();

    const view = createDefaultView();
    vi.mocked(swarmClaimSettingsApi.get).mockResolvedValueOnce(view);

    retryButton?.click();
    await flushReact();

    expect(swarmClaimSettingsApi.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".ui2-error-state")).toBeNull();
    expect(container.querySelector("#ui2-swarm-claim-enabled")).not.toBeNull();
  });
});
