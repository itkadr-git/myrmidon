// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DataRetentionSettingsPanel } from "./DataRetentionSettingsPanel";
import * as dataRetentionApiModule from "./dataRetentionApi";

function renderPanel(): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <DataRetentionSettingsPanel />
    </QueryClientProvider>,
  );
  return container;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const view = {
  settings: { heartbeatRunsDays: 90, activityLogDays: 90, accessAuditDays: 365 },
  sources: {
    heartbeatRunsDays: "default",
    activityLogDays: "settings",
    accessAuditDays: "default",
  },
  status: {
    lastRunAt: "2026-10-05T03:00:00.000Z",
    waitingForBackup: false,
    backupCheckedAt: "2026-10-05T03:00:00.000Z",
    freedBytesTotal: 1024 * 1024 * 12,
    perTable: {
      runs: { deletedTotal: 1200, lastDeleted: 30, lastFreedBytes: 1024 * 1024 * 8 },
      activity: { deletedTotal: 400, lastDeleted: 0, lastFreedBytes: 0 },
      access: { deletedTotal: 90, lastDeleted: 7, lastFreedBytes: 1024 * 1024 * 4 },
    },
  },
};

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("DataRetentionSettingsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("shows the three retention windows and the last sweep readout", async () => {
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "get").mockResolvedValue(view as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="data-retention-status"]')));

    const runs = container.querySelector<HTMLInputElement>(
      '[data-testid="data-retention-heartbeatRunsDays-input"]',
    );
    const activity = container.querySelector<HTMLInputElement>(
      '[data-testid="data-retention-activityLogDays-input"]',
    );
    const access = container.querySelector<HTMLInputElement>(
      '[data-testid="data-retention-accessAuditDays-input"]',
    );
    expect(runs?.value).toBe("90");
    expect(activity?.value).toBe("90");
    expect(access?.value).toBe("365");

    expect(container.textContent).toContain("Last cleanup:");
    expect(container.textContent).toContain("2026-10-05T03:00:00.000Z");
    expect(container.textContent).toContain("Run history — 1200 rows deleted in total");
    expect(container.textContent).toContain("30 in the last sweep");
    expect(container.textContent).toContain("8.0 MB freed");
    expect(container.textContent).toContain("Access audit logs — 90 rows deleted in total");
    expect(container.textContent).toContain("Total freed: 12.0 MB");
    expect(container.querySelector('[data-testid="data-retention-waiting-backup"]')).toBeNull();
  });

  it("saves all three windows in one patch", async () => {
    const update = vi.fn().mockResolvedValue(view);
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "get").mockResolvedValue(view as never);
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="data-retention-status"]')));

    const runs = container.querySelector<HTMLInputElement>(
      '[data-testid="data-retention-heartbeatRunsDays-input"]',
    );
    await act(async () => {
      setInputValue(runs!, "30");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="data-retention-save"]')!.click();
    });
    await waitFor(() => update.mock.calls.length > 0);
    expect(update).toHaveBeenCalledWith({
      heartbeatRunsDays: 30,
      activityLogDays: 90,
      accessAuditDays: 365,
    });
  });

  it("external machine backup: the checkbox reflects the view and saves only the mode", async () => {
    const update = vi.fn().mockResolvedValue({ ...view, externalMachineBackup: true });
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "get").mockResolvedValue(view as never);
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="data-retention-status"]')));

    const box = container.querySelector<HTMLInputElement>(
      '[data-testid="data-retention-external-backup"]',
    );
    // absent in the view (older server) reads as off
    expect(box?.checked).toBe(false);
    await act(async () => {
      box!.click();
    });
    await waitFor(() => update.mock.calls.length > 0);
    // only the mode goes out; the three windows are not re-sent
    expect(update).toHaveBeenCalledWith({ externalMachineBackup: true });
  });

  it("external machine backup: checked when the server says so", async () => {
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "get").mockResolvedValue({
      ...view,
      externalMachineBackup: true,
    } as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="data-retention-status"]')));
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="data-retention-external-backup"]')
        ?.checked,
    ).toBe(true);
  });

  it("accepts 0 as keep-forever", async () => {
    const update = vi.fn().mockResolvedValue(view);
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "get").mockResolvedValue(view as never);
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="data-retention-status"]')));

    const activity = container.querySelector<HTMLInputElement>(
      '[data-testid="data-retention-activityLogDays-input"]',
    );
    await act(async () => {
      setInputValue(activity!, "0");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="data-retention-save"]')!.click();
    });
    await waitFor(() => update.mock.calls.length > 0);
    expect(update).toHaveBeenCalledWith({
      heartbeatRunsDays: 90,
      activityLogDays: 0,
      accessAuditDays: 365,
    });
    expect(container.querySelector('[data-testid="data-retention-activityLogDays-error"]')).toBeNull();
  });

  it("rejects a negative or fractional draft locally and never calls the API", async () => {
    const update = vi.fn();
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "get").mockResolvedValue(view as never);
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "update").mockImplementation(update as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="data-retention-status"]')));

    const access = container.querySelector<HTMLInputElement>(
      '[data-testid="data-retention-accessAuditDays-input"]',
    );
    for (const invalid of ["-1", "2.5"]) {
      await act(async () => {
        setInputValue(access!, invalid);
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="data-retention-save"]')!.click();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(update).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="data-retention-accessAuditDays-error"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain("Enter a whole number of days (0 or more)");
    }
  });

  it("shows the waiting-for-backup note when the sweep is gated on a fresh backup", async () => {
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "get").mockResolvedValue({
      ...view,
      status: { ...view.status, waitingForBackup: true, lastRunAt: null },
    } as never);
    const container = renderPanel();
    await waitFor(() =>
      Boolean(container.querySelector('[data-testid="data-retention-waiting-backup"]')),
    );
    expect(container.textContent).toContain("it starts once a backup younger than 24 hours exists");
    expect(container.textContent).toContain("Last cleanup: never");
  });

  it("renders nothing when the instance does not serve the retention route", async () => {
    vi.spyOn(dataRetentionApiModule.dataRetentionApi, "get").mockRejectedValue(
      new Error("Request failed: 404"),
    );
    const container = renderPanel();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    // No empty "Data retention" block of dead inputs on an instance without the route.
    expect(container.querySelector('[data-testid="data-retention-panel"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="data-retention-heartbeatRunsDays-input"]'),
    ).toBeNull();
    expect(container.textContent).toBe("");
  });
});