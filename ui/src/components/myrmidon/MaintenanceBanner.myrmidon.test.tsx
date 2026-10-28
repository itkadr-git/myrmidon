import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { AgentListItem } from "../../api/agents";
import {
  aggregateMaintenance,
  MaintenanceBannerView,
} from "./MaintenanceBanner";
import { MaintenanceSettingsPanelView } from "./MaintenanceSettingsPanel";
import type { MaintenanceStatus, MaintenanceWindow } from "./maintenanceApi";
import en from "../../i18n/locales/en.json";
import ru from "../../i18n/locales/ru.json";

function window(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: "w-1",
    scope: { type: "instance" },
    state: "on",
    reason: "database migration",
    enteredAt: "2026-04-18T10:00:00.000Z",
    onTimeout: "abort",
    ...overrides,
  };
}

function status(windows: MaintenanceWindow[]): MaintenanceStatus {
  return {
    active: windows.length > 0,
    windows,
  };
}

function agentWindows(count: number, companyId = "company-a", reason = "bot container template update"): MaintenanceWindow[] {
  return Array.from({ length: count }, (_, i) =>
    window({
      id: `w-agent-${i}`,
      scope: { type: "agent", id: `agent-${i}` },
      companyId,
      reason,
      queuedWakes: 0,
    }),
  );
}

describe("MaintenanceBanner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.use(initReactI18next).init({
      lng: "en",
      fallbackLng: "en",
      resources: {
        en: { translation: en },
        ru: { translation: ru },
      },
      interpolation: { escapeValue: false },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function renderBanner(value: MaintenanceStatus | undefined, companyId: string | null = "company-a") {
    flushSync(() => root.render(<MaintenanceBannerView status={value} companyId={companyId} />));
    return container.querySelector('[data-testid="myrmidon-maintenance-banner"]');
  }

  function renderScopedBanner(
    value: MaintenanceStatus | undefined,
    companyId: string | null = "company-a",
    agents?: AgentListItem[] | null,
  ) {
    flushSync(() => root.render(<MaintenanceBannerView status={value} companyId={companyId} agents={agents} />));
    return container.querySelector('[data-testid="myrmidon-maintenance-scoped-banner"]');
  }

  it("is hidden outside maintenance", () => {
    expect(renderBanner(undefined)).toBeNull();
    expect(renderBanner(status([]))).toBeNull();
    expect(renderScopedBanner(undefined)).toBeNull();
    expect(renderScopedBanner(status([]))).toBeNull();
  });

  it("shows an instance window on every company", () => {
    const bannerA = renderBanner(status([window()]), "company-a");
    const bannerB = renderBanner(status([window()]), "company-b");
    expect(bannerA).not.toBeNull();
    expect(bannerB).not.toBeNull();
  });

  it("shows a draining window with its running runs", () => {
    const draining = window({
      state: "draining",
      drain: { deadline: "2026-04-18T10:10:00.000Z", runningRuns: 3, timedOutRuns: 0 },
    });
    const banner = renderBanner(status([draining]), "company-a")!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("draining, runs still running: 3");
  });

  it("shows narrower windows only in their company", () => {
    const agentWindow = window({ id: "w-agent", scope: { type: "agent", id: "agent-a" }, companyId: "company-a" });
    expect(renderScopedBanner(status([agentWindow]), "company-a")).not.toBeNull();
    expect(renderScopedBanner(status([agentWindow]), "company-b")).toBeNull();
    // Agent window does not trigger the general board-wide banner
    expect(renderBanner(status([agentWindow]), "company-a")).toBeNull();
  });

  it("does not show general banner for single agent window, shows discrete scoped banner with link", () => {
    const agentWindow = window({
      id: "w-eng-17",
      scope: { type: "agent", id: "adm-dev-eng-17" },
      companyId: "company-a",
      reason: "bot container profile update (adm-dev-eng-17)",
    });

    // 1. General board-wide banner is NOT rendered
    expect(renderBanner(status([agentWindow]), "company-a")).toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-maintenance-details"]')).toBeNull();

    // 2. Discrete scoped banner IS rendered
    const scoped = renderScopedBanner(status([agentWindow]), "company-a")!;
    expect(scoped).not.toBeNull();
    expect(scoped.textContent).toContain("adm-dev-eng-17");
    expect(scoped.textContent).toContain("Updating bot container for");
    expect(scoped.textContent).toContain("(~1 min), the rest of the board is working");

    // 3. Has link to the agent
    const link = scoped.querySelector("a")!;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("/agents/adm-dev-eng-17");
    expect(link.textContent).toBe("adm-dev-eng-17");
  });

  it("resolves agent name and urlKey from agents prop when available", () => {
    const agentWindow = window({
      id: "w-eng-17",
      scope: { type: "agent", id: "agent-uuid-17" },
      companyId: "company-a",
      reason: "bot container profile update (adm-dev-eng-17)",
    });
    const agents = [
      {
        id: "agent-uuid-17",
        name: "adm-dev-eng-17",
        urlKey: "eng-17",
        role: "engineer",
        companyId: "company-a",
        status: "active",
      } as any,
    ];
    const scoped = renderScopedBanner(status([agentWindow]), "company-a", agents)!;
    expect(scoped).not.toBeNull();
    expect(scoped.textContent).toContain("adm-dev-eng-17");
    const link = scoped.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/agents/eng-17");
  });

  it("renders Russian discrete banner when locale is Russian", () => {
    i18n.changeLanguage("ru");
    try {
      const agentWindow = window({
        id: "w-eng-17",
        scope: { type: "agent", id: "adm-dev-eng-17" },
        companyId: "company-a",
        reason: "bot container profile update (adm-dev-eng-17)",
      });
      const scoped = renderScopedBanner(status([agentWindow]), "company-a")!;
      expect(scoped).not.toBeNull();
      expect(scoped.textContent).toContain("Обновляется контейнер бота");
      expect(scoped.textContent).toContain("adm-dev-eng-17");
      expect(scoped.textContent).toContain("(~1 мин), остальная доска работает");
      expect(renderBanner(status([agentWindow]), "company-a")).toBeNull();
    } finally {
      i18n.changeLanguage("en");
    }
  });

  it("shows discrete banner for department scope", () => {
    const deptWindow = window({
      id: "w-dept-1",
      scope: { type: "department", id: "dept-1" },
      companyId: "company-a",
      reason: "department routine upgrade",
    });
    expect(renderBanner(status([deptWindow]), "company-a")).toBeNull();
    const scoped = renderScopedBanner(status([deptWindow]), "company-a")!;
    expect(scoped).not.toBeNull();
    expect(scoped.textContent).toContain("Maintenance for project (~1 min), the rest of the board is working");
  });

  it("groups 47 agent windows into one row when board-wide window is active", () => {
    const banner = renderBanner(status([window(), ...agentWindows(47, "company-a")]), "company-a")!;
    expect(banner).not.toBeNull();
    const rows = banner.querySelectorAll('[data-testid="myrmidon-maintenance-row"]');
    expect(rows.length).toBe(2);
    expect(rows[1]?.textContent).toContain("Agent maintenance (on)");
    expect(rows[1]?.textContent).toContain("agents: 47");
    expect(rows[1]?.textContent).toContain("queued wakeups: 0");
  });

  it("groups 47 agent windows in aggregateMaintenance helper", () => {
    const { rows } = aggregateMaintenance(status(agentWindows(47, "company-a")), "company-a");
    expect(rows.length).toBe(1);
    expect(rows[0]?.scopeType).toBe("agent");
    expect(rows[0]?.windowCount).toBe(47);
  });

  it("separates different reasons into distinct rows", () => {
    const windows = [
      window(),
      ...agentWindows(5, "company-a", "reason A"),
      ...agentWindows(3, "company-a", "reason B"),
    ];
    const banner = renderBanner(status(windows), "company-a")!;
    const rows = banner.querySelectorAll('[data-testid="myrmidon-maintenance-row"]');
    expect(rows.length).toBe(3);
  });

  it("shows instance and agent windows as rows of one plaque", () => {
    const banner = renderBanner(status([window(), ...agentWindows(2, "company-a")]), "company-a")!;
    expect(banner.querySelectorAll('[data-testid="myrmidon-maintenance-row"]').length).toBe(2);
    expect(banner.textContent).toContain("the whole instance");
    expect(banner.textContent).toContain("bot container template update");
  });

  it("keeps windows ending separately from windows on", () => {
    const endingWindow = window({
      id: "w-ending",
      scope: { type: "agent", id: "agent-ending" },
      companyId: "company-a",
      state: "ending",
      reason: "bot container template update",
    });
    const banner = renderBanner(status([window(), endingWindow, ...agentWindows(2, "company-a")]), "company-a")!;
    const rows = banner.querySelectorAll('[data-testid="myrmidon-maintenance-row"]');
    expect(rows.length).toBe(3);
  });

  it("shows aggregate summary with counts and plural kinds", () => {
    const banner = renderBanner(status([window(), ...agentWindows(2, "company-a")]), "company-a")!;
    const summary = banner.querySelector('[data-testid="myrmidon-maintenance-summary"]')!;
    expect(summary.textContent).toContain("Maintenance windows: 3 across 2 kind(s)");
  });

  it("shows draining details per row", () => {
    const drainingAgent = window({
      id: "w-drain",
      scope: { type: "agent", id: "agent-drain" },
      companyId: "company-a",
      state: "draining",
      drain: { deadline: "2026-04-18T10:10:00.000Z", runningRuns: 2, timedOutRuns: 1 },
      reason: "bot container template update",
    });
    const banner = renderBanner(status([window(), drainingAgent]), "company-a")!;
    expect(banner.textContent).toContain("draining, runs past the timeout: 1");
  });
});

describe("MaintenanceSettingsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function renderPanel(value: MaintenanceStatus, onEnter = vi.fn(), onExit = vi.fn()) {
    flushSync(() =>
      root.render(
        <MaintenanceSettingsPanelView status={value} onEnter={onEnter} onExit={onExit} pending={false} error={null} />,
      ),
    );
    return { onEnter, onExit };
  }

  function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    flushSync(() => element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })));
  }

  it("enters instance maintenance with the chosen timeout and action", () => {
    const { onEnter } = renderPanel(status([]));
    expect(container.textContent).toContain("No maintenance window is open.");
    setValue(container.querySelector<HTMLInputElement>("#myrmidon-maintenance-reason")!, "deploy");
    setValue(container.querySelector<HTMLInputElement>("#myrmidon-maintenance-timeout")!, "60");
    setValue(container.querySelector<HTMLSelectElement>("#myrmidon-maintenance-on-timeout")!, "interrupt_and_retry");
    flushSync(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onEnter).toHaveBeenCalledWith({
      scope: { type: "instance" },
      reason: "deploy",
      drainTimeoutSec: 60,
      onTimeout: "interrupt_and_retry",
    });
  });

  it("asks for confirmation before ending a window", () => {
    const { onExit } = renderPanel(status([window()]));
    const endButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "End maintenance")!;
    flushSync(() => endButton.click());
    expect(onExit).not.toHaveBeenCalled();
    const confirm = [...container.querySelectorAll("button")].find((b) => b.textContent === "Confirm end")!;
    flushSync(() => confirm.click());
    expect(onExit).toHaveBeenCalledWith({ type: "instance" });
  });
});
