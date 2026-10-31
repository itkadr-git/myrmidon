// ui/src/ui2/screens/settings/runs-queue/Ui2TaskDrainBlock.myrmidon.test.tsx
//
// myrmidon(UI2): component test for the task drain control block in Runs & queue.
// Verifies idle status, active status with expiry, start confirmation flow,
// stop action, and error handling.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2TaskDrainBlock } from "./Ui2TaskDrainBlock";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";
import type { TaskDrainStatus } from "../../../../api/instanceSettings";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getTaskDrain: vi.fn(),
  startTaskDrain: vi.fn(),
  stopTaskDrain: vi.fn(),
}));

vi.mock("../../../../api/instanceSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../api/instanceSettings")>();
  return {
    ...actual,
    instanceSettingsApi: {
      ...actual.instanceSettingsApi,
      getTaskDrain: mockInstanceSettingsApi.getTaskDrain,
      startTaskDrain: mockInstanceSettingsApi.startTaskDrain,
      stopTaskDrain: mockInstanceSettingsApi.stopTaskDrain,
    },
  };
});

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Ui2TaskDrainBlock", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    queryClient.clear();
  });

  it("renders idle state when drain is not active (ru locale)", async () => {
    const idleStatus: TaskDrainStatus = {
      draining: false,
      startedAt: null,
      expiresAt: null,
      activeRuns: 0,
      pendingWakes: 0,
      quiescent: true,
    };
    mockInstanceSettingsApi.getTaskDrain.mockResolvedValue(idleStatus);

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="ru">
            <Ui2TaskDrainBlock />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const statusEl = container.querySelector("[data-testid='ui2-task-drain-status']");
    expect(statusEl?.textContent).toContain("Слив не идёт");

    const startBtn = container.querySelector<HTMLButtonElement>("[data-testid='ui2-task-drain-start-btn']");
    expect(startBtn).not.toBeNull();
    expect(startBtn?.textContent).toContain("Начать слив");

    const stopBtn = container.querySelector("[data-testid='ui2-task-drain-stop-btn']");
    expect(stopBtn).toBeNull();

    const select = container.querySelector<HTMLSelectElement>("[data-testid='ui2-task-drain-ttl-select']");
    expect(select).not.toBeNull();
    expect(select?.options.length).toBe(4);
  });

  it("start drain sends POST with chosen ttlMs only after confirmation", async () => {
    const idleStatus: TaskDrainStatus = {
      draining: false,
      startedAt: null,
      expiresAt: null,
      activeRuns: 0,
      pendingWakes: 0,
      quiescent: true,
    };
    mockInstanceSettingsApi.getTaskDrain.mockResolvedValue(idleStatus);
    mockInstanceSettingsApi.startTaskDrain.mockResolvedValue({
      startedAt: "2026-10-31T10:00:00.000Z",
      expiresAt: "2026-10-31T14:00:00.000Z",
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="ru">
            <Ui2TaskDrainBlock />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Select 4 hours (14_400_000 ms)
    const select = container.querySelector<HTMLSelectElement>("[data-testid='ui2-task-drain-ttl-select']");
    expect(select).not.toBeNull();
    flushSync(() => {
      select!.value = "14400000";
      select!.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await flushReact();

    // Click "Начать слив"
    const startBtn = container.querySelector<HTMLButtonElement>("[data-testid='ui2-task-drain-start-btn']");
    expect(startBtn).not.toBeNull();
    flushSync(() => {
      startBtn!.click();
    });
    await flushReact();

    // POST must NOT have been called yet
    expect(mockInstanceSettingsApi.startTaskDrain).not.toHaveBeenCalled();

    // Confirmation dialog should be visible
    const confirmDialog = container.querySelector("[data-testid='ui2-task-drain-confirm-dialog']");
    expect(confirmDialog).not.toBeNull();

    // Click "Отмена"
    const cancelBtn = container.querySelector<HTMLButtonElement>("[data-testid='ui2-task-drain-cancel-btn']");
    expect(cancelBtn).not.toBeNull();
    flushSync(() => {
      cancelBtn!.click();
    });
    await flushReact();

    // Dialog dismissed, still no POST
    expect(container.querySelector("[data-testid='ui2-task-drain-confirm-dialog']")).toBeNull();
    expect(mockInstanceSettingsApi.startTaskDrain).not.toHaveBeenCalled();

    // Click "Начать слив" again
    const startBtnAgain = container.querySelector<HTMLButtonElement>("[data-testid='ui2-task-drain-start-btn']");
    flushSync(() => {
      startBtnAgain!.click();
    });
    await flushReact();

    // Click "Подтвердить запуск"
    const confirmBtn = container.querySelector<HTMLButtonElement>("[data-testid='ui2-task-drain-confirm-btn']");
    expect(confirmBtn).not.toBeNull();
    flushSync(() => {
      confirmBtn!.click();
    });
    await flushReact();

    // POST should now be called with { ttlMs: 14400000 }
    expect(mockInstanceSettingsApi.startTaskDrain).toHaveBeenCalledWith({ ttlMs: 14400000 });
  });

  it("renders active draining state with expiry time and stop button, stop sends DELETE", async () => {
    const activeStatus: TaskDrainStatus = {
      draining: true,
      startedAt: "2026-10-31T10:00:00.000Z",
      expiresAt: "2026-10-31T14:00:00.000Z",
      activeRuns: 3,
      pendingWakes: 0,
      quiescent: false,
    };
    mockInstanceSettingsApi.getTaskDrain.mockResolvedValue(activeStatus);
    mockInstanceSettingsApi.stopTaskDrain.mockResolvedValue({ wasActive: true });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="ru">
            <Ui2TaskDrainBlock />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const statusEl = container.querySelector("[data-testid='ui2-task-drain-status']");
    expect(statusEl?.textContent).toContain("Идёт слив очереди");

    const expiryEl = container.querySelector("[data-testid='ui2-task-drain-expiry']");
    expect(expiryEl?.textContent).toContain("2026-10-31 14:00:00 UTC");

    const activeRunsEl = container.querySelector("[data-testid='ui2-task-drain-active-runs']");
    expect(activeRunsEl?.textContent).toContain("3");

    const startBtn = container.querySelector("[data-testid='ui2-task-drain-start-btn']");
    expect(startBtn).toBeNull();

    const stopBtn = container.querySelector<HTMLButtonElement>("[data-testid='ui2-task-drain-stop-btn']");
    expect(stopBtn).not.toBeNull();
    expect(stopBtn?.textContent).toContain("Остановить слив");

    flushSync(() => {
      stopBtn!.click();
    });
    await flushReact();

    expect(mockInstanceSettingsApi.stopTaskDrain).toHaveBeenCalled();
  });

  it("shows error message instead of blank screen on API error (no permission)", async () => {
    mockInstanceSettingsApi.getTaskDrain.mockRejectedValue(new Error("403 Forbidden"));

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="ru">
            <Ui2TaskDrainBlock />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const errorEl = container.querySelector("[data-testid='ui2-task-drain-error']");
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain("Нет прав");
  });

  it("renders in English when locale is en", async () => {
    const idleStatus: TaskDrainStatus = {
      draining: false,
      startedAt: null,
      expiresAt: null,
      activeRuns: 0,
      pendingWakes: 0,
      quiescent: true,
    };
    mockInstanceSettingsApi.getTaskDrain.mockResolvedValue(idleStatus);

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2TaskDrainBlock />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const statusEl = container.querySelector("[data-testid='ui2-task-drain-status']");
    expect(statusEl?.textContent).toContain("Queue drain is not active");

    const startBtn = container.querySelector<HTMLButtonElement>("[data-testid='ui2-task-drain-start-btn']");
    expect(startBtn?.textContent).toContain("Start drain");
  });
});
