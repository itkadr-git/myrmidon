// @vitest-environment jsdom
// myrmidon(PROCS-1.1): tests for the "Processes of the board" settings section.
// The panel is the only place an operator changes the process settings, so the
// tests cover what it must not get wrong: the mode it shows is the saved one,
// the mode in force is named separately, a saved-but-unrunnable mode is
// explained, and a change is sent as a patch.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROCESSES_SETTINGS, PROCESSES_SPLIT_UNSUPPORTED_REASON } from "@paperclipai/shared";
import { ProcessesSettingsPanel } from "./ProcessesSettingsPanel";
import type { ProcessesSettingsView } from "./processesApi";

const mockProcessesApi = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));

vi.mock("./processesApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./processesApi")>();
  return { ...actual, processesApi: mockProcessesApi };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function view(overrides: Partial<ProcessesSettingsView> = {}): ProcessesSettingsView {
  return {
    settings: { ...DEFAULT_PROCESSES_SETTINGS },
    sources: {
      mode: "default",
      apiCount: "default",
      leaderLeaseTtlSec: "default",
      liveEventsBus: "default",
      admissionStore: "default",
      singletonProxy: "default",
    },
    effectiveMode: "single",
    notInEffectReason: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

function renderPanel() {
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ProcessesSettingsPanel />
      </QueryClientProvider>,
    );
  });
}

async function renderLoaded(current: ProcessesSettingsView) {
  mockProcessesApi.get.mockResolvedValue(current);
  renderPanel();
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="myrmidon-processes-mode"]')).not.toBeNull();
  });
}

describe("ProcessesSettingsPanel", () => {
  it("shows the default single mode, the mode in force, and no notice", async () => {
    await renderLoaded(view());
    const select = container.querySelector<HTMLSelectElement>('[data-testid="myrmidon-processes-mode"]');
    expect(select?.value).toBe("single");
    expect(container.querySelector('[data-testid="myrmidon-processes-effective"]')?.textContent).toContain(
      "Single (one process does everything)",
    );
    expect(container.querySelector('[data-testid="myrmidon-processes-notice"]')).toBeNull();
    expect(container.textContent ?? "").toContain("Saved here");
  });

  it("explains a saved split that this build cannot run yet", async () => {
    await renderLoaded(
      view({
        settings: { ...DEFAULT_PROCESSES_SETTINGS, mode: "split" },
        sources: { ...view().sources, mode: "settings" },
        effectiveMode: "single",
        notInEffectReason: PROCESSES_SPLIT_UNSUPPORTED_REASON,
      }),
    );
    const select = container.querySelector<HTMLSelectElement>('[data-testid="myrmidon-processes-mode"]');
    expect(select?.value).toBe("split");
    const notice = container.querySelector('[data-testid="myrmidon-processes-notice"]')?.textContent ?? "";
    expect(notice).toContain("not in effect");
    expect(notice).toContain(PROCESSES_SPLIT_UNSUPPORTED_REASON);
    expect(container.querySelector('[data-testid="myrmidon-processes-effective"]')?.textContent).toContain(
      "Single (one process does everything)",
    );
  });

  it("sends the mode as a patch when the operator changes it", async () => {
    await renderLoaded(view());
    mockProcessesApi.update.mockResolvedValue(
      view({ settings: { ...DEFAULT_PROCESSES_SETTINGS, mode: "split" }, sources: { ...view().sources, mode: "settings" } }),
    );
    const select = container.querySelector<HTMLSelectElement>('[data-testid="myrmidon-processes-mode"]');
    expect(select).not.toBeNull();
    flushSync(() => {
      select!.value = "split";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(mockProcessesApi.update).toHaveBeenCalledWith({ mode: "split" });
    });
  });

  it("shows the unavailable notice when the settings request fails", async () => {
    mockProcessesApi.get.mockRejectedValue(new Error("boom"));
    renderPanel();
    await vi.waitFor(() => {
      expect(container.textContent ?? "").toContain("unavailable");
    });
    expect(container.querySelector('[data-testid="myrmidon-processes-mode"]')).toBeNull();
  });
});